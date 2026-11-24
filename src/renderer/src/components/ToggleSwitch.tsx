interface ToggleSwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
}

/** 开关（role=switch），设置页共用 */
export default function ToggleSwitch({ checked, onChange }: ToggleSwitchProps) {
  return (
    <button
      role="switch"
      aria-checked={checked}
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
