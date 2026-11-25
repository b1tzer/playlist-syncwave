interface ToggleSwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** 无障碍名称（设置项标题），读屏可读；缺省时回退通用描述 */
  ariaLabel?: string
}

/** 开关（role=switch），设置页共用 */
export default function ToggleSwitch({ checked, onChange, ariaLabel }: ToggleSwitchProps) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? 'toggle'}
      onClick={() => onChange(!checked)}
      className={`h-6 w-11 rounded-full p-0.5 transition-colors ${
        checked ? 'bg-primary' : 'bg-surface-container-highest'
      }`}
    >
      <span
        className={`block h-5 w-5 rounded-full bg-on-surface transition-transform duration-300 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] ${
          checked ? 'translate-x-5' : ''
        }`}
      />
    </button>
  )
}
