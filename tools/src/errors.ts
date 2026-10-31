/**
 * A command used wrongly, such as a missing argument. The command line prints it with the usage and exits
 * with code 2.
 */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/**
 * A request the ledger refuses as it stands, or a failure reading it: a schema the validator cannot apply, or
 * a file that exists but cannot be read. The command line prints it and exits with code 1.
 */
export class LedgerError extends Error {
  override readonly name = "LedgerError";
}
