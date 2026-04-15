/**
 * Re-exports of shared types used across renderer stores/components.
 * Keeping one import path reduces churn when shared types move.
 */
export type {
  Settings,
  ModuleMeta,
  ModuleId,
  ModuleSettings,
  ModuleManifest,
  PaletteItem,
  PaletteShowPayload,
  SearchRequest,
  SearchResult,
  Theme
} from '@shared/types'
