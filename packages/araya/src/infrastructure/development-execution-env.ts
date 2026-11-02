import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'

import { withoutDiscordEnvironment } from '../config/environment.ts'

export function createDevelopmentExecutionEnv(
  options: ConstructorParameters<typeof NodeExecutionEnv>[0],
) {
  const shellEnv = withoutDiscordEnvironment(options.shellEnv ?? {})
  const environment = new NodeExecutionEnv({ ...options, shellEnv })
  const originalExec = environment.exec.bind(environment)

  environment.exec = (...args: Parameters<typeof environment.exec>) => {
    const [command, execOptions, context] = args

    return originalExec(
      command,
      {
        ...execOptions,
        env: {
          ...shellEnv,
          ...withoutDiscordEnvironment(execOptions?.env ?? {}),
        },
        inheritEnv: false,
      },
      context,
    )
  }

  return environment
}
