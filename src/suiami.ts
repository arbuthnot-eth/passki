/**
 * SuiAMI — re-exports from the `suiami` package.
 *
 * Maintains backward compatibility with existing imports across the codebase.
 */

export {
  buildMessage as buildSuiamiMessage,
  createProof as createSuiamiProof,
  parseProof as parseSuiamiProof,
  extractName,
  ROSTER_PACKAGE,
  ROSTER_OBJECT,
  type SuiamiMessage,
  type SuiamiProof,
  type CrossChainAddresses,
} from 'suiami';
