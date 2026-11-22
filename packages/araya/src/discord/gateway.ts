// discord.js との接続。型Importだけにして discord.js の実行時 import は関内に行う（CLI 起動や test で load しない）
// gateway interface を関数にすることで bot.ts の loop を fake で test できる

import type {
  ApplicationCommandDataResolvable,
  ChatInputCommandInteraction,
  GuildTextBasedChannel,
  Interaction,
} from 'discord.js'
import { type DiscordConfig } from './config.ts'
import { discordChatAdmissionFailures, type DiscordChatAdmissionFailure, type DiscordChatMessage, type DiscordChatMessageMetadata } from './chat.ts'
import { isArayaCommandName, REMOVED_COMMAND_REPLY, type SlashCommand } from './slash.ts'

// slash command の interaction を handler に渡すための形（command 名は slash.ts の ARAYA_COMMAND_NAMES）
export type DiscordCommandRequest = {
  interactionId: string
  commandName: string
  userId: string
  guildId: string | null
  channelId: string | null
  subcommandGroup: string | null
  subcommand: string
  options: Record<string, string | number | boolean | undefined>
}

export type DiscordCommandReplyFn = (content: string) => Promise<void>
export type DiscordMessageReplyFn = (content: string, nonce: string) => Promise<void>

// 許可条件に落ちて session に渡らなかった message の証跡（IDs のみ・本文を含めない）
export type DiscordIgnoredMessage = DiscordChatMessageMetadata & { messageId: string }

export type DiscordGatewayHandlers = {
  onReady(botUserId?: string): Promise<void> | void
  // slash command を扱う handler。省略されたら interaction は「撤去済み」の ephemeral reply で返す
  onInteraction?(request: DiscordCommandRequest, reply: DiscordCommandReplyFn): Promise<void> | void
  onMessage(message: DiscordChatMessage, reply: DiscordMessageReplyFn): Promise<void> | void
  onError(message: string): void
  // 取りこぼし診断。許可条件の失敗理由を IDs 付きで受け取る（本文は渡さない）
  onIgnored?(metadata: DiscordIgnoredMessage, failures: DiscordChatAdmissionFailure[]): void
}

export type DiscordGateway = {
  connect(): Promise<void>
  sendText(content: string, nonce: string): Promise<void>
  // guild への slash command 登録（bulk overwrite。同じ定義を何度流しても置き換えになる）
  registerCommands(commands: readonly SlashCommand[]): Promise<number>
  close(): Promise<void>
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// Discord typing event は10秒で失効するため、少し余裕を持って更新する。
const DISCORD_TYPING_REFRESH_INTERVAL_MS = 8_000

export type DiscordTypingChannel = Pick<GuildTextBasedChannel, 'sendTyping'>

export function createDiscordTypingIndicator(onError: (message: string) => void) {
  const activeRequests = new Set<symbol>()
  let channel: DiscordTypingChannel | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let sending = false
  let refreshPending = false

  async function sendTyping(queueRefreshIfSending = false) {
    if (activeRequests.size === 0 || channel === undefined) {
      return
    }

    if (sending) {
      if (queueRefreshIfSending) {
        refreshPending = true
      }

      return
    }

    sending = true

    try {
      await channel.sendTyping()
    } catch (error) {
      // typing 表示の失敗で会話返信まで止めない。
      try {
        onError(`Discord typing indicator failed: ${errorMessage(error)}`)
      } catch {
        // error logger の失敗も会話処理へ伝播させない。
      }
    } finally {
      sending = false

      if (refreshPending) {
        refreshPending = false
        void sendTyping()
      }
    }
  }

  function stop() {
    if (interval !== undefined) {
      clearInterval(interval)
    }

    interval = undefined
    channel = undefined
    refreshPending = false
  }

  function release(request: symbol) {
    if (!activeRequests.delete(request)) {
      return
    }

    if (activeRequests.size === 0) {
      stop()
    }
  }

  return {
    run: async <T>(target: DiscordTypingChannel, operation: () => Promise<T> | T) => {
      const request = Symbol()
      activeRequests.add(request)
      channel = target

      if (interval === undefined) {
        interval = setInterval(() => {
          void sendTyping(true)
        }, DISCORD_TYPING_REFRESH_INTERVAL_MS)
      }

      void sendTyping()

      try {
        return await operation()
      } finally {
        release(request)
      }
    },
    close: () => {
      activeRequests.clear()
      stop()
    },
  }
}

export function discordGatewayIntents(bits: {
  Guilds: number
  GuildMessages: number
  MessageContent: number
}) {
  return [bits.Guilds, bits.GuildMessages, bits.MessageContent]
}

export function discordNotificationPayload(content: string, nonce: string) {
  return { content, nonce, enforceNonce: true, allowedMentions: { parse: [] } }
}

type InteractionOption = ChatInputCommandInteraction['options']['data'][number]

export function flattenDiscordCommandOptions(entries: readonly InteractionOption[]) {
  const options: Record<string, string | number | boolean | undefined> = {}

  for (const entry of entries) {
    if (entry.type === 1 || entry.type === 2) {
      Object.assign(options, flattenDiscordCommandOptions(entry.options ?? []))
      continue
    }

    if (typeof entry.name !== 'string') {
      continue
    }

    options[entry.name] =
      typeof entry.value === 'number' || typeof entry.value === 'boolean'
        ? entry.value
        : String(entry.value)
  }

  return options
}

// task 機構の撤去後に返す案内（slash.ts の 1 つの text を共有する）。routeSlashCommandInteraction の実経路で test する
export { REMOVED_COMMAND_REPLY as OBSOLETE_COMMAND_REPLY } from './slash.ts'

// slash command interaction の実処理。createDiscordGateway の client.on('interactionCreate') は
// この function を呼ぶだけ。handler 不在時は ephemeral の撤去案内を返し、throw しない
export async function routeSlashCommandInteraction(
  interaction: Interaction,
  handlers: DiscordGatewayHandlers,
) {
  if (!interaction.isChatInputCommand() || !isArayaCommandName(interaction.commandName)) {
    return
  }

  const discord = await import('discord.js')
  const commandInteraction: ChatInputCommandInteraction = interaction

  let subcommandGroup: string | null
  let subcommand: string

  try {
    subcommandGroup = commandInteraction.options.getSubcommandGroup(false)
    subcommand = commandInteraction.options.getSubcommand()
  } catch {
    handlers.onError('slash command の subcommand が読めません')

    return
  }

  // group と subcommand を再帰的に除き、実際に指定された option だけを渡す
  let replied = false
  async function reply(content: string) {
    if (!replied) {
      replied = true
      await commandInteraction.reply({ content, flags: discord.MessageFlags.Ephemeral })

      return
    }

    await commandInteraction.followUp({ content, flags: discord.MessageFlags.Ephemeral })
  }

  if (!handlers.onInteraction) {
    try {
      await reply(REMOVED_COMMAND_REPLY)
    } catch (error: unknown) {
      handlers.onError(errorMessage(error))
    }

    return
  }

  try {
    await handlers.onInteraction(
      {
        interactionId: commandInteraction.id,
        commandName: commandInteraction.commandName,
        userId: commandInteraction.user.id,
        guildId: commandInteraction.guildId,
        channelId: commandInteraction.channelId,
        subcommandGroup,
        subcommand,
        options: flattenDiscordCommandOptions(commandInteraction.options.data),
      },
      reply,
    )
  } catch (error: unknown) {
    handlers.onError(errorMessage(error))
  }
}

// client と routeSlashCommandInteraction の配線。fake client で実配線を test できるように切り出す
export function wireSlashCommandInteractions(
  client: {
    on(event: 'interactionCreate', listener: (interaction: Interaction) => void): unknown
  },
  handlers: DiscordGatewayHandlers,
) {
  client.on('interactionCreate', (interaction) => {
    void routeSlashCommandInteraction(interaction, handlers)
  })
}

// messageCreate の event から handler が使う最小の形。discord.js の Message 全体を test に渡さない
export type DiscordMessageCreateEvent = {
  id: string
  guildId: string | null
  channelId: string
  author: { id: string; bot: boolean }
  webhookId: string | null
  system: boolean
  mentions: { users: { has(id: string): boolean } }
  content: string
  inGuild(): boolean
  // typing 表示と返信に使う channel 能力（discord.js の TextBasedChannel と同じ形）
  channel: {
    isTextBased(): boolean
    sendTyping(): Promise<void>
  }
  reply(payload: ReturnType<typeof discordNotificationPayload>): Promise<unknown>
}

// 受信 message を session に渡すか破棄するか決める。本文を取り出す前に guild/channel/user を絞る
export function handleDiscordMessageCreate(
  message: DiscordMessageCreateEvent,
  config: DiscordConfig,
  handlers: DiscordGatewayHandlers,
  typingIndicator: ReturnType<typeof createDiscordTypingIndicator>,
  botUserId: string | undefined,
) {
  const metadata = {
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    isBot: message.author.bot,
    isWebhook: message.webhookId !== null,
    isSystem: message.system,
    mentionsBot: botUserId !== undefined && message.mentions.users.has(botUserId),
  }

  // Araya 自身の echo は会話でも取りこぼしでもないので log を汚さない
  if (botUserId !== undefined && message.author.id === botUserId) {
    return
  }

  // Message Content intent は有効だが、本文を取り出す前に guild/channel/user を絞る。
  // 破棄は handlers.onIgnored に IDs + 理由だけ残す（本文は渡さない）
  const failures = discordChatAdmissionFailures(metadata, config)

  if (failures.length > 0) {
    handlers.onIgnored?.({ ...metadata, messageId: message.id }, failures)

    return
  }

  async function reply(content: string, nonce: string) {
    if (!message.channel.isTextBased()) {
      throw new Error('Discord message の返信先が text channel ではありません')
    }

    await message.reply(discordNotificationPayload(content, nonce))
  }

  function onMessage() {
    return handlers.onMessage(
      {
        ...metadata,
        messageId: message.id,
        content: message.content,
      },
      reply,
    )
  }

  void (
    message.inGuild() && message.channel.isTextBased()
      ? typingIndicator.run(message.channel, onMessage)
      : Promise.resolve().then(onMessage)
  ).catch((error: unknown) => {
    handlers.onError(errorMessage(error))
  })
}

export async function createDiscordGateway(
  config: DiscordConfig,
  handlers: DiscordGatewayHandlers,
) {
  const discord = await import('discord.js')
  const client = new discord.Client({ intents: discordGatewayIntents(discord.GatewayIntentBits) })
  const typingIndicator = createDiscordTypingIndicator(handlers.onError)

  // login() は ready を待つが、test の fake と揃えるため ready を待つ promise を明示する
  const readyCallbacks: { resolve?: () => void; reject?: (error: Error) => void } = {}
  let readySettled = false
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyCallbacks.resolve = resolve
    readyCallbacks.reject = reject
  })

  client.once('ready', () => {
    readySettled = true
    readyCallbacks.resolve?.()
    void Promise.resolve(handlers.onReady(client.user?.id)).catch((error: unknown) => {
      handlers.onError(errorMessage(error))
    })
  })
  client.on('error', (error: Error) => {
    if (!readySettled) {
      readySettled = true
      readyCallbacks.reject?.(error)
    }

    handlers.onError(errorMessage(error))
  })
  client.on('close', () => {
    if (!readySettled) {
      readySettled = true
      readyCallbacks.reject?.(new Error('Discord connection が ready になる前に閉じられました'))
    }
  })

  wireSlashCommandInteractions(client, handlers)

  client.on('messageCreate', (message) => {
    handleDiscordMessageCreate(message, config, handlers, typingIndicator, client.user?.id)
  })

  return {
    connect: async () => {
      await client.login(config.botToken)
      await readyPromise
    },
    // 同じ event に対する再送が Discord 側で 1 通にまとまるよう nonce を渡す
    sendText: async (content, nonce) => {
      const channel = await client.channels.fetch(config.channelId)

      if (channel === null || !('send' in channel)) {
        throw new Error('設定された Discord channel に送信できません')
      }

      await channel.send(discordNotificationPayload(content, nonce))
    },
    // guild 配下の command を bulk overwrite で登録する（bot startup から呼ぶ）。同じ定義を何度流しても置き換え。
    // client.application が null（ready 前）なら error。呼び出し側で log して会話機能は続ける
    registerCommands: async (commands) => {
      if (client.application === null) {
        throw new Error('discord_application_unavailable: client.application がありません（ready 後に登録してください）')
      }

      const registered = await client.application.commands.set(
        commands as unknown as readonly ApplicationCommandDataResolvable[],
        config.guildId,
      )

      return registered.size
    },
    close: async () => {
      typingIndicator.close()
      await client.destroy()
    },
  } satisfies DiscordGateway
}
