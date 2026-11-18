import type { IconType } from 'react-icons'
import {
  SiAmd,
  SiAnthropic,
  SiArduino,
  SiAutodesk,
  SiBasecamp,
  SiBrave,
  SiCanva,
  SiCorsair,
  SiCrunchyroll,
  SiDeepl,
  SiDell,
  SiDiscord,
  SiElgato,
  SiFitbit,
  SiFramer,
  SiGithub,
  SiGooglegemini,
  SiGuilded,
  SiIkea,
  SiImgur,
  SiInstagram,
  SiIntel,
  SiJetbrains,
  SiLinear,
  SiMake,
  SiMongodb,
  SiNotion,
  SiNvidia,
  SiOpenai,
  SiPatreon,
  SiQwant,
  SiRoblox,
  SiScribd,
  SiSketchup,
  SiSpotify,
  SiSquare,
  SiSteam,
  SiStrava,
  SiTailscale,
  SiTeamviewer,
  SiTelegram,
  SiTiktok,
  SiTwitch,
  SiWhatsapp,
  SiWix,
  SiX,
  SiYoutube
} from 'react-icons/si'
import {
  FaBan,
  FaBrain,
  FaCloud,
  FaCode,
  FaDatabase,
  FaFileShield,
  FaGamepad,
  FaGlobe,
  FaImage,
  FaLink,
  FaLock,
  FaMicrochip,
  FaMusic,
  FaRobot,
  FaServer,
  FaVideo
} from 'react-icons/fa6'

/**
 * Brand icons for the services users recognise. Everything else falls back to
 * a category icon, so an unknown/new catalog entry never breaks the page.
 */
const BRAND: Record<string, IconType> = {
  'hosts.discord': SiDiscord,
  'hosts.youtube': SiYoutube,
  'hosts.github': SiGithub,
  'hosts.githubusercontent_ipv6': SiGithub,
  'hosts.whatsapp_ipv6': SiWhatsapp,
  'hosts.x_twitter': SiX,
  'hosts.instagram': SiInstagram,
  'hosts.flowseal_discord_voice': SiDiscord,
  'hosts.supercell': FaGamepad,
  'hosts.render': FaCloud,
  'hosts.rutor': FaLink,
  'hosts.ntc_party_ipv4': FaGlobe,
  'custom.telegram': SiTelegram,

  'dns.chatgpt_and_sora_openai': SiOpenai,
  'dns.gemini_ai': SiGooglegemini,
  'dns.claude': SiAnthropic,
  'dns.github_copilot': SiGithub,
  'dns.grok': SiX,
  'dns.adobe_ai': FaFileShield,
  'dns.cursor_ai': FaCode,
  'dns.windsurf': FaCode,
  'dns.trae_ai': FaCode,
  'dns.opencode_ai': FaCode,
  'dns.cerebras_ai': FaBrain,
  'dns.groq_ai': FaBrain,
  'dns.camel_ai': FaBrain,
  'dns.dola_ai': FaBrain,
  'dns.hume_ai': FaBrain,
  'dns.monica': FaBrain,
  'dns.manus': FaRobot,
  'dns.meta_ai': FaRobot,
  'dns.openrouter': FaRobot,

  'dns.spotify': SiSpotify,
  'dns.twitch': SiTwitch,
  'dns.notion': SiNotion,
  'dns.deepl': SiDeepl,
  'dns.canva': SiCanva,
  'dns.jetbrains': SiJetbrains,
  'dns.nvidia': SiNvidia,
  'dns.amd': SiAmd,
  'dns.intel': SiIntel,
  'dns.teamviewer': SiTeamviewer,
  'dns.brave': SiBrave,
  'dns.arduino': SiArduino,
  'dns.ikea': SiIkea,
  'dns.wix': SiWix,
  'dns.mongodb': SiMongodb,
  'dns.autodesk': SiAutodesk,
  'dns.fitbit': SiFitbit,
  'dns.framer': SiFramer,
  'dns.imgur': SiImgur,
  'dns.crunchyroll': SiCrunchyroll,
  'dns.corsair': SiCorsair,
  'dns.tiktok': SiTiktok,
  'dns.patreon': SiPatreon,
  'dns.tailscale': SiTailscale,
  'dns.elgato': SiElgato,
  'dns.guilded': SiGuilded,
  'dns.linear_app': SiLinear,
  'dns.make': SiMake,
  'dns.qwant': SiQwant,
  'dns.sketchup': SiSketchup,
  'dns.strava': SiStrava,
  'dns.scribd': SiScribd,
  'dns.square': SiSquare,
  'dns.dell': SiDell,
  'dns.37signals': SiBasecamp,
  'dns.chess': FaGamepad,
  'dns.formula_1': FaGamepad,
  'dns.game8': FaGamepad,
  'dns.capcut': FaVideo,
  'dns.elevenlabs': FaMusic,
  'dns.deezer': FaMusic,
  'dns.mangalib': FaImage,
  'dns.parsec': FaGamepad,
  'dns.reve': FaImage,
  'dns.weather_underground': FaCloud,
  'dns.weather_com': FaCloud,
  'dns.web_archive': FaDatabase,
  'dns.workos': FaCode,
  'dns.zerossl': FaLock,
  'dns.coreweave': FaServer,
  'dns.cummins': FaMicrochip,
  'dns.microchip': FaMicrochip,
  'dns.analog': FaMicrochip,
  'dns.broadcom': FaMicrochip,
  'dns.oracle': FaDatabase,
  'dns.tuta': FaLock,
  'dns.tria_ge': FaFileShield,
  'dns.truth_social': FaGlobe
}

const BY_ICON: Record<string, IconType> = {
  'fa5b.discord': SiDiscord,
  'fa5b.youtube': SiYoutube,
  'fa5b.github': SiGithub,
  'fa5b.whatsapp': SiWhatsapp,
  'fa5b.twitter': SiX,
  'fa5b.instagram': SiInstagram,
  'fa5b.spotify': SiSpotify,
  'fa5b.twitch': SiTwitch,
  'fa5b.notion': SiNotion,
  'fa5b.adobe': FaFileShield,
  'fa5b.steam': SiSteam,
  'fa5b.roblox': SiRoblox,
  'fa5b.tiktok': SiTiktok,
  'fa5b.patreon': SiPatreon,
  'fa5b.telegram': SiTelegram,
  'fa5s.globe': FaGlobe,
  'fa5s.ban': FaBan
}

const CATEGORY_FALLBACK: Record<HostsService['category'], IconType> = {
  direct: FaLink,
  ai: FaRobot,
  other: FaGlobe
}

/** Pick a readable brand colour; very dark colours fall back to currentColor. */
function readableColor(color?: string | null): string | undefined {
  if (!color) return undefined
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!match) return color
  const value = match[1]
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance < 0.32 ? undefined : color
}

const HostsServiceIcon: React.FC<{ service: HostsService; className?: string }> = ({
  service,
  className
}) => {
  const Icon =
    BRAND[service.id] ??
    BY_ICON[service.icon] ??
    CATEGORY_FALLBACK[service.category] ??
    FaGlobe
  return (
    <Icon
      className={className}
      style={{ color: readableColor(service.color) }}
      aria-hidden="true"
    />
  )
}

export default HostsServiceIcon
