/**
 * PromaLogoSettings - Xcode 品牌 Logo 下载
 *
 * 展示多个 Xcode Logo 颜色变体网格，用户可下载用作机器人头像。
 */

import * as React from 'react'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { Button } from '@/components/ui/button'

// ===== Logo 资源导入 =====

// 基础色系
import promaBlackLogo from '@/assets/bots/proma-logos/proma-black.png'
import promaWhiteLogo from '@/assets/bots/proma-logos/proma-white.png'
import promaBlueLogo from '@/assets/bots/proma-logos/proma-blue.png'
import promaPurpleLogo from '@/assets/bots/proma-logos/proma-purple.png'
import promaGradientLogo from '@/assets/bots/proma-logos/proma-gradient.png'
import promaTransparentLogo from '@/assets/bots/proma-logos/proma-transparent.png'

// 潘通年度色
import promaCoralLogo from '@/assets/bots/proma-logos/proma-coral.png'
import promaVeriPeriLogo from '@/assets/bots/proma-logos/proma-veri-peri.png'
import promaVivaMagentaLogo from '@/assets/bots/proma-logos/proma-viva-magenta.png'
import promaMochaMousseLogo from '@/assets/bots/proma-logos/proma-mocha-mousse.png'
import promaEmeraldLogo from '@/assets/bots/proma-logos/proma-emerald.png'

// 科技风格
import proma8bitLogo from '@/assets/bots/proma-logos/proma-8bit.png'
import promaCyberpunkLogo from '@/assets/bots/proma-logos/proma-cyberpunk.png'
import promaFuturisticLogo from '@/assets/bots/proma-logos/proma-futuristic.png'

// ===== 类型 =====

interface LogoVariant {
  id: string
  name: string
  description: string
  src: string
  resourcePath: string
  previewBg: string
}

// ===== Logo 变体定义 =====

const LOGO_VARIANTS: readonly LogoVariant[] = [
  // 基础色系
  {
    id: 'black',
    name: '石墨黑',
    description: 'Xcode 默认品牌色，圆润交叉 X',
    src: promaBlackLogo,
    resourcePath: 'proma-logos/proma-black.png',
    previewBg: 'bg-[#2D2E2B]',
  },
  {
    id: 'white',
    name: '米白版',
    description: '米白背景，石墨色标志',
    src: promaWhiteLogo,
    resourcePath: 'proma-logos/proma-white.png',
    previewBg: 'bg-[#F0EEE7]',
  },
  {
    id: 'blue',
    name: '雾蓝',
    description: '低饱和雾蓝，可选配色',
    src: promaBlueLogo,
    resourcePath: 'proma-logos/proma-blue.png',
    previewBg: 'bg-[#687D90]',
  },
  {
    id: 'purple',
    name: '紫色版',
    description: '紫色调，个性风格',
    src: promaPurpleLogo,
    resourcePath: 'proma-logos/proma-purple.png',
    previewBg: 'bg-purple-900',
  },
  {
    id: 'gradient',
    name: '渐变版',
    description: '石墨灰柔和渐变背景',
    src: promaGradientLogo,
    resourcePath: 'proma-logos/proma-gradient.png',
    previewBg: 'bg-gradient-to-br from-[#2D2E2B] to-[#797B70]',
  },
  {
    id: 'transparent',
    name: '透明底',
    description: '无背景，可叠加任意颜色',
    src: promaTransparentLogo,
    resourcePath: 'proma-logos/proma-transparent.png',
    previewBg: 'bg-[repeating-conic-gradient(#e5e7eb_0%_25%,#fff_0%_50%)] bg-[length:16px_16px]',
  },
  // 潘通年度色
  {
    id: 'coral',
    name: '玫瑰粉',
    description: '明快玫瑰粉，个性配色',
    src: promaCoralLogo,
    resourcePath: 'proma-logos/proma-coral.png',
    previewBg: 'bg-[#F4729C]',
  },
  {
    id: 'veri-peri',
    name: '长春花蓝',
    description: 'Pantone 2022 Very Peri',
    src: promaVeriPeriLogo,
    resourcePath: 'proma-logos/proma-veri-peri.png',
    previewBg: 'bg-[#6667AB]',
  },
  {
    id: 'viva-magenta',
    name: '非凡洋红',
    description: 'Pantone 2023 Viva Magenta',
    src: promaVivaMagentaLogo,
    resourcePath: 'proma-logos/proma-viva-magenta.png',
    previewBg: 'bg-[#BB2649]',
  },
  {
    id: 'mocha-mousse',
    name: '摩卡慕斯',
    description: 'Pantone 2025 Mocha Mousse',
    src: promaMochaMousseLogo,
    resourcePath: 'proma-logos/proma-mocha-mousse.png',
    previewBg: 'bg-[#A47764]',
  },
  {
    id: 'emerald',
    name: '翡翠绿',
    description: 'Pantone 2013 Emerald',
    src: promaEmeraldLogo,
    resourcePath: 'proma-logos/proma-emerald.png',
    previewBg: 'bg-[#009473]',
  },
  // 科技风格
  {
    id: '8bit',
    name: '暖灰',
    description: '柔和暖灰，圆润线条',
    src: proma8bitLogo,
    resourcePath: 'proma-logos/proma-8bit.png',
    previewBg: 'bg-[#8A8174]',
  },
  {
    id: 'cyberpunk',
    name: '赛博朋克',
    description: '霓虹赛博风格',
    src: promaCyberpunkLogo,
    resourcePath: 'proma-logos/proma-cyberpunk.png',
    previewBg: 'bg-[#0d0221]',
  },
  {
    id: 'futuristic',
    name: '未来质感',
    description: '金属全息科技风',
    src: promaFuturisticLogo,
    resourcePath: 'proma-logos/proma-futuristic.png',
    previewBg: 'bg-[#4a4a4a]',
  },
] as const

// ===== 组件 =====

function LogoCard({ logo }: { logo: LogoVariant }): React.ReactElement {
  const handleDownload = React.useCallback(async () => {
    try {
      const saved = await window.electronAPI.saveResourceFileAs(
        logo.resourcePath,
        `xcodes-${logo.id}.png`,
      )
      if (saved) {
        toast.success(`${logo.name} 已保存`)
      }
    } catch {
      toast.error('保存失败，请重试')
    }
  }, [logo])

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={cn(
          'w-20 h-20 rounded-xl overflow-hidden border border-border/50 flex items-center justify-center',
          logo.previewBg,
        )}
      >
        <img
          src={logo.src}
          alt={logo.name}
          className="w-full h-full object-contain"
          draggable={false}
        />
      </div>
      <div className="text-center">
        <div className="text-xs font-medium">{logo.name}</div>
        <div className="text-[10px] text-muted-foreground">{logo.description}</div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="w-full gap-1.5 h-7 text-xs"
        onClick={handleDownload}
      >
        <Download size={12} />
        下载
      </Button>
    </div>
  )
}

export function PromaLogoSettings(): React.ReactElement {
  return (
    <>
      <SettingsSection
        title="品牌 Logo"
        description="下载 Xcode Logo 用作机器人头像，让用户一眼认出你的 AI 助手"
      >
        <div className="grid grid-cols-3 gap-4">
          {LOGO_VARIANTS.map((logo) => (
            <LogoCard key={logo.id} logo={logo} />
          ))}
        </div>
      </SettingsSection>

      <div className="my-6 border-t border-border/50" />

      <SettingsSection
        title="使用提示"
        description="在机器人平台设置头像时参考"
      >
        <SettingsCard divided={false}>
          <div className="px-4 py-3 space-y-1.5 text-sm text-muted-foreground">
            <p>建议使用 PNG 格式，飞书/钉钉头像推荐 200x200 以上。</p>
            <p>透明背景版本适合需要自定义背景色的平台。</p>
            <p>渐变版和科技风格在社交平台头像中辨识度最高。</p>
          </div>
        </SettingsCard>
      </SettingsSection>
    </>
  )
}
