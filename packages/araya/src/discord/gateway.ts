// discord.js との接続。型Importだけにして discord.js の実行時 import は関内に行う（CLI 起動や test で load しない）
// gateway interface を関数にすることで bot.ts の loop を fake で test できる

import type { ChatInputCommandInteraction } from 'discord.js'
import { type DiscordConfig } from './config.ts'
import {
  ARAYA_COMMAND_NAME,
  discordCommandDefinitionJson,
  type DiscordCommandRequest,
} from './interactions.ts'
import { isDiscordChatMessageAllowed, type DiscordChatMessage } from './chat.ts'

export type DiscordCommandReplyFn = (content: string) => Promise<void>
export type DiscordMessageReplyFn = (content: string, nonce: string) => Promise<void>

export type DiscordGatewayHandlers = {
  onReady(botUserId?: string): Promise<void> | void
  onInteraction(request: DiscordCommandRequest, reply: DiscordCommandReplyFn): Promise<void> | void
  onMessage(message: DiscordChatMessage, reply: DiscordMessageReplyFn): Promise<void> | void
  onError(message: string): void
}

export type DiscordGateway = {
  connect(): Promise<void>
  sendText(content: string, nonce: string): Promise<void>
  close(): Promise<void>
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function discordGatewayIntents(bits: { Guilds: number; GuildMessages: number }) {
  return [bits.Guilds, bits.GuildMessages]
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

// slash command 定義を Discord の guild へ登録する（araya discord register）
export async function registerDiscordCommands(config: DiscordConfig) {
  const { REST, Routes } = await import('discord.js')
  await new REST({ version: '10' })
    .setToken(config.botToken)
    .put(Routes.applicationGuildCommands(config.applicationId, config.guildId), {
      body: discordCommandDefinitionJson(),
    })
}

export async function createDiscordGateway(
  config: DiscordConfig,
  handlers: DiscordGatewayHandlers,
) {
  const discord = await import('discord.js')
  const client = new discord.Client({ intents: discordGatewayIntents(discord.GatewayIntentBits) })

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

  client.on('interactionCreate', (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== ARAYA_COMMAND_NAME) {
      return
    }

    let subcommandGroup: string | null
    let subcommand: string

    try {
      subcommandGroup = interaction.options.getSubcommandGroup(false)
      subcommand = interaction.options.getSubcommand()
    } catch {
      handlers.onError('slash command の subcommand が読めません')

      return
    }

    // group と subcommand を再帰的に除き、実際に指定された option だけを渡す
    let replied = false
    const commandInteraction = interaction
    async function reply(content: string) {
      if (!replied) {
        replied = true
        await commandInteraction.reply({ content, flags: discord.MessageFlags.Ephemeral })

        return
      }

      await commandInteraction.followUp({ content, flags: discord.MessageFlags.Ephemeral })
    }

    void Promise.resolve(
      handlers.onInteraction(
        {
          interactionId: interaction.id,
          userId: interaction.user.id,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          subcommandGroup,
          subcommand,
          options: flattenDiscordCommandOptions(interaction.options.data),
        },
        reply,
      ),
    ).catch((error: unknown) => {
      handlers.onError(errorMessage(error))
    })
  })

  client.on('messageCreate', (message) => {
    const botUserId = client.user?.id
    const metadata = {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      isBot: message.author.bot,
      isWebhook: message.webhookId !== null,
      mentionsBot: botUserId !== undefined && message.mentions.users.has(botUserId),
    }

    // channel/user/mention を確認する前に本文を読み込まない。
    if (!isDiscordChatMessageAllowed(metadata, config)) {
      return
    }

    async function reply(content: string, nonce: string) {
      if (!message.channel.isTextBased()) {
        throw new Error('Discord message の返信先が text channel ではありません')
      }

      await message.reply(discordNotificationPayload(content, nonce))
    }

    void Promise.resolve(
      handlers.onMessage(
        {
          ...metadata,
          messageId: message.id,
          content: message.content,
        },
        reply,
      ),
    ).catch((error: unknown) => {
      handlers.onError(errorMessage(error))
    })
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
    close: async () => {
      await client.destroy()
    },
  } satisfies DiscordGateway
}
