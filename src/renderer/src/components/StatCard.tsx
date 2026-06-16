import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface StatCardProps {
  label: string
  value: React.ReactNode
  delta?: React.ReactNode
  deltaClassName?: string
  className?: string
}

export function StatCard({ label, value, delta, deltaClassName, className }: StatCardProps) {
  return (
    <Card className={cn('p-5', className)}>
      <div className="mb-1.5 font-mono text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-2xl font-bold leading-none tabular-nums">{value}</div>
      {delta != null && (
        <div className={cn('mt-2 font-mono text-xs text-muted-foreground', deltaClassName)}>{delta}</div>
      )}
    </Card>
  )
}
