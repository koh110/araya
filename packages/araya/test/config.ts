export function readProcessEnvironment(name: string) {
  return process.env[name]
}

export function readAllProcessEnvironment() {
  return { ...process.env }
}
