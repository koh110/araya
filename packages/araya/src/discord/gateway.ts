// discord.js との接続。型Importだけにして discord.js の実行時 import は関内に行う（CLI 起動や test で load しない）
// gateway interface を関数にすることで bot.ts の loop を fake で test できる

import { type DiscordConfig } from './config.ts'
import {
  ARAYA_COMMAND_NAME,
  discordCommandDefinitionJson,
  type DiscordCommandRequest,
} from './interactions.ts'

export type DiscordCommandReplyFn = (content: string) => Promise<void>

export type DiscordGatewayHandlers = {
  onReady(): Promise<void> | void
  onInteraction(request: DiscordCommandRequest, reply: DiscordCommandReplyFn): Promise<void> | void
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

export function discordNotificationPayload(content: string, nonce: string) {
  return { content, nonce, enforceNonce: true, allowedMentions: { parse: [] } }
}

// slash command 定義を Discord の guild へ登録する（araya discord register）
export async function registerDiscordCommands(config: DiscordConfig) {
  const { REST, Routes } = await import('discord.js')
  const rest = new REST({ version: '10' }).setToken(config.botToken)
  await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), {
    body: discordCommandDefinitionJson(),
  })
}

export async function createDiscordGateway(
  config: DiscordConfig,
  handlers: DiscordGatewayHandlers,
) {
  const discord = await import('discord.js')
  const client = new discord.Client({ intents: [discord.GatewayIntentBits.Guilds] })

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
    void Promise.resolve(handlers.onReady()).catch((error: unknown) => {
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

    let subcommand: string

    try {
      subcommand = interaction.options.getSubcommand()
    } catch {
      handlers.onError('slash command の subcommand が読めません')

      return
    }

    const options: Record<string, string | number | boolean | undefined> = {}

    // 定義されていない option を getString で引くと誤りになるため、届いた option だけを読む
    for (const entry of interaction.options.data) {
      const nested = entry.type === 1 ? (entry.options ?? []) : [entry]

      for (const option of nested) {
        if (typeof option.name !== 'string') {
          continue
        }

        options[option.name] =
          typeof option.value === 'number' || typeof option.value === 'boolean'
            ? option.value
            : String(option.value)
      }
    }

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
          subcommand,
          options,
        },
        reply,
      ),
    ).catch((error: unknown) => {
      handlers.onError(errorMessage(error))
    })
  })

  const gateway: DiscordGateway = {
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
  }

  return gateway
}
