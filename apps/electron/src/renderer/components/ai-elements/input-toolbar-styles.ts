export const inputAreaContainerClass =
  'mx-auto w-full max-w-[800px] px-5 pb-4 sm:px-8'

export const inputAreaFadeClass =
  'before:pointer-events-none before:absolute before:-inset-x-5 before:-top-8 before:-z-10 before:h-12 before:bg-gradient-to-t before:from-content-area before:via-content-area/85 before:to-transparent'

export const inputCardClass =
  'input-surface-card !rounded-[20px] border border-black/[0.07] bg-[hsl(var(--input-surface))] shadow-[0_5px_20px_-12px_rgba(15,23,42,0.28),0_1px_4px_rgba(15,23,42,0.04)] transition-[border-color,box-shadow] duration-150 focus-within:border-black/[0.11] focus-within:shadow-[0_7px_24px_-12px_rgba(15,23,42,0.30),0_2px_6px_rgba(15,23,42,0.05)] dark:border-white/[0.10] dark:shadow-[0_7px_24px_-14px_rgba(0,0,0,0.72)] dark:focus-within:border-white/[0.16] dark:focus-within:shadow-[0_9px_28px_-14px_rgba(0,0,0,0.78)]'

export const inputToolbarButtonClass =
  'size-7 shrink-0 rounded-md text-foreground/55 hover:text-foreground hover:bg-muted/55 data-[state=open]:bg-muted/55 data-[state=open]:text-foreground'

export const inputToolbarActiveButtonClass =
  '!bg-transparent text-primary shadow-none hover:!bg-transparent hover:text-primary data-[state=open]:!bg-transparent [&_svg]:stroke-[2.75]'

export const inputToolbarDangerButtonClass =
  'size-8 shrink-0 rounded-full !bg-foreground !text-background shadow-sm hover:!bg-foreground/88 hover:!text-background'

export const inputToolbarSendButtonClass =
  'size-8 shrink-0 rounded-full !bg-foreground !text-background shadow-sm hover:!bg-foreground/88 hover:!text-background'

export const inputToolbarDisabledButtonClass =
  'size-8 shrink-0 rounded-full !bg-muted !text-muted-foreground/45 shadow-none cursor-not-allowed'
