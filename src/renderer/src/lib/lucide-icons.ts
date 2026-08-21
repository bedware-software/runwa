import AlertTriangle from 'lucide-react/dist/esm/icons/triangle-alert.js'
import AppWindow from 'lucide-react/dist/esm/icons/app-window.js'
import ArrowUpDown from 'lucide-react/dist/esm/icons/arrow-up-down.js'
import Book from 'lucide-react/dist/esm/icons/book.js'
import BookOpen from 'lucide-react/dist/esm/icons/book-open.js'
import Check from 'lucide-react/dist/esm/icons/check.js'
import CheckCircle2 from 'lucide-react/dist/esm/icons/circle-check.js'
import Circle from 'lucide-react/dist/esm/icons/circle.js'
import Clipboard from 'lucide-react/dist/esm/icons/clipboard.js'
import Clock from 'lucide-react/dist/esm/icons/clock.js'
import CornerDownLeft from 'lucide-react/dist/esm/icons/corner-down-left.js'
import Download from 'lucide-react/dist/esm/icons/download.js'
import EyeOff from 'lucide-react/dist/esm/icons/eye-off.js'
import FolderOpen from 'lucide-react/dist/esm/icons/folder-open.js'
import GraduationCap from 'lucide-react/dist/esm/icons/graduation-cap.js'
import Hash from 'lucide-react/dist/esm/icons/hash.js'
import Info from 'lucide-react/dist/esm/icons/info.js'
import Keyboard from 'lucide-react/dist/esm/icons/keyboard.js'
import KeyboardOff from 'lucide-react/dist/esm/icons/keyboard-off.js'
import Library from 'lucide-react/dist/esm/icons/library.js'
import Loader2 from 'lucide-react/dist/esm/icons/loader-circle.js'
import Maximize2 from 'lucide-react/dist/esm/icons/maximize-2.js'
import Mic from 'lucide-react/dist/esm/icons/mic.js'
import Minimize2 from 'lucide-react/dist/esm/icons/minimize-2.js'
import Package from 'lucide-react/dist/esm/icons/package.js'
import Pencil from 'lucide-react/dist/esm/icons/pencil.js'
import Plus from 'lucide-react/dist/esm/icons/plus.js'
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw.js'
import Replace from 'lucide-react/dist/esm/icons/replace.js'
import Rocket from 'lucide-react/dist/esm/icons/rocket.js'
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw.js'
import Settings from 'lucide-react/dist/esm/icons/settings.js'
import SlidersHorizontal from 'lucide-react/dist/esm/icons/sliders-horizontal.js'
import Square from 'lucide-react/dist/esm/icons/square.js'
import SunMoon from 'lucide-react/dist/esm/icons/sun-moon.js'
import Tag from 'lucide-react/dist/esm/icons/tag.js'
import Terminal from 'lucide-react/dist/esm/icons/terminal.js'
import Trash2 from 'lucide-react/dist/esm/icons/trash-2.js'
import X from 'lucide-react/dist/esm/icons/x.js'
import XCircle from 'lucide-react/dist/esm/icons/circle-x.js'
import type { LucideIcon } from 'lucide-react'

const ICONS_BY_HINT = {
  'app-window': AppWindow,
  book: Book,
  'book-open': BookOpen,
  'check-circle-2': CheckCircle2,
  clock: Clock,
  'folder-open': FolderOpen,
  'graduation-cap': GraduationCap,
  info: Info,
  keyboard: Keyboard,
  'keyboard-off': KeyboardOff,
  library: Library,
  'maximize-2': Maximize2,
  mic: Mic,
  'minimize-2': Minimize2,
  package: Package,
  plus: Plus,
  'refresh-cw': RefreshCw,
  replace: Replace,
  rocket: Rocket,
  settings: Settings,
  square: Square,
  'sun-moon': SunMoon,
  terminal: Terminal
} satisfies Record<string, LucideIcon>

export function lucideIconFromHint(
  hint: string | undefined,
  fallback: LucideIcon
): LucideIcon {
  if (!hint) return fallback
  return ICONS_BY_HINT[hint as keyof typeof ICONS_BY_HINT] ?? fallback
}

export function optionalLucideIconFromHint(
  hint: string | undefined
): LucideIcon | null {
  if (!hint) return null
  return ICONS_BY_HINT[hint as keyof typeof ICONS_BY_HINT] ?? null
}

export {
  AlertTriangle,
  AppWindow,
  ArrowUpDown,
  Check,
  CheckCircle2,
  Circle,
  Clipboard,
  Clock,
  CornerDownLeft,
  Download,
  EyeOff,
  FolderOpen,
  GraduationCap,
  Hash,
  Info,
  Keyboard,
  Loader2,
  Mic,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Square,
  SunMoon,
  Tag,
  Terminal,
  Trash2,
  X,
  XCircle
}
export type { LucideIcon }
