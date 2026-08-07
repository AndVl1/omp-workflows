/**
 * OMP discovery adapter for the canonical CTO contract in core.
 *
 * The command is copied into the consumer project because OMP 17.x discovers
 * custom-TS commands from `.omp/commands`. Behaviour and state handling stay
 * in @andvl1/omp-workflows-core.
 */
export {
  buildAmendPrompt,
  buildCtoPrompt,
  buildStandbyCtoPrompt,
  findActiveCtoRun,
  parseCtoEnvelope as parseEnvelope,
  renderChannelSection,
  type ParsedCtoEnvelope as ParsedEnvelope,
} from "@andvl1/omp-workflows-core";
