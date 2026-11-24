import { createContext, useContext } from 'react'

/**
 * True inside the settings page of a module that is switched off. The page
 * still shows every setting, but nothing in it can be changed: ModulePanel
 * wraps the page in a disabled, inert fieldset, which locks every native
 * control at once (buttons, inputs, switches, checkboxes, selects) and gives
 * them the design system's disabled look through `:disabled`.
 *
 * The hook is for the few controls whose disabled look hangs on a prop
 * rather than on `:disabled` — InputField draws its frame on a wrapper div —
 * and for anything that should skip work while the module is off.
 */
export const ModuleLockContext = createContext(false)

export function useModuleLocked(): boolean {
  return useContext(ModuleLockContext)
}
