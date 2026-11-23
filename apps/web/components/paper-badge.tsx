export function PaperBadge() {
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-moss/50 bg-sand px-3 py-1 text-xs font-medium text-forest"
      title="Balances and fills are simulated at live True Markets prices. No real money moves."
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-moss" />
      Paper trading · no real money
    </span>
  );
}
