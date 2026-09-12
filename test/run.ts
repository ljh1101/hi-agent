/**
 * Single-process test entry point.
 *
 * `node --test` runs every file in its own child process, which some sandboxed
 * environments block (spawned children cannot open pipes). Importing the suites
 * into one process avoids that entirely, so `npm test` works everywhere.
 */
import './agent.test.ts'
import './calculator.test.ts'
import './integration.test.ts'
import './llm.test.ts'
import './tools.test.ts'
