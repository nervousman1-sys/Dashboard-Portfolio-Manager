// ============================================================================
// LHE · Public API (barrel)
// ----------------------------------------------------------------------------
// נקודת הכניסה היחידה לצרכני המנוע. ייבוא נקי:
//   import { runLHE, generateLHEAlert } from '@/lib/lhe';
// ============================================================================

export * from './types';
export { DEFAULT_LHE_CONFIG, resolveConfig } from './config';
export { computeHPI } from './layer1-macro';
export { computeAssetConduit, rankConduits } from './layer2-conduits';
export {
  computeATR,
  detectFVGs,
  detectOrderBlocks,
  detectStructureShift,
  computeGravity,
} from './layer3-microstructure';
export { runLHE } from './engine';
export { generateLHEAlert } from './alerts';
