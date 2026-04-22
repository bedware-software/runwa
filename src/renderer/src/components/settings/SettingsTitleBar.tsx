import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

/**
 * Prefer navigator.userAgentData (Chromium 90+), fall back to the deprecated
 * navigator.platform string. Matches what Electron's renderer sees.
 */
function detectMac(): boolean {
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData
  if (uaData?.platform) return uaData.platform === 'macOS'
  return navigator.platform.toLowerCase().includes('mac')
}

/**
 * Draggable title bar for the settings window.
 *
 * The whole bar is a drag region (`-webkit-app-region: drag`) — any interactive
 * child must opt out with `WebkitAppRegion: 'no-drag'`, or clicks get swallowed
 * by the drag surface.
 *
 * Platform padding reserves space so content doesn't collide with the OS
 * window controls: 80px on the left for macOS traffic lights, 142px on the
 * right for the Windows/Linux titleBarOverlay min/max/close strip.
 *
 * Height is 48px (h-12) with a 1px bottom border. The Windows titleBarOverlay
 * is sized to 47px — intentionally 1px shorter than the toolbar — so the
 * bottom border runs full width, visible even under the min/max/close strip.
 * box-sizing: border-box means h-12 is 47px content + 1px border inside 48.
 */
export function SettingsTitleBar() {
  const [isMac, setIsMac] = useState(false)
  useEffect(() => {
    setIsMac(detectMac())
  }, [])

  const style: CSSProperties = {
    paddingLeft: isMac ? 80 : 12,
    paddingRight: isMac ? 12 : 142,
    WebkitAppRegion: 'drag'
  } as CSSProperties

  return (
    <div
      className="h-12 bg-card border-b border-border flex items-center gap-2 shrink-0 select-none"
      style={style}
    >
      <span className="text-sm font-semibold text-foreground">runwa</span>
    </div>
  )
}
