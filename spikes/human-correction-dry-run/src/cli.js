export class CliArgumentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CliArgumentError';
    this.code = code;
  }
}

export function parseStrictArgs(argv, { allowed, required = [] }) {
  const allowedNames = new Set(allowed);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || key.length === 2 || value === undefined || value.startsWith('--')) {
      throw new CliArgumentError('invalid-arguments', 'arguments must be provided as --name value pairs');
    }
    const name = key.slice(2);
    if (!allowedNames.has(name)) {
      throw new CliArgumentError('unknown-argument', `unknown argument: --${name}`);
    }
    if (Object.hasOwn(options, name)) {
      throw new CliArgumentError('duplicate-argument', `duplicate argument: --${name}`);
    }
    options[name] = value;
  }
  for (const name of required) {
    if (!Object.hasOwn(options, name)) {
      throw new CliArgumentError(`missing-${name}`, `${name} is required`);
    }
  }
  return Object.freeze(options);
}
