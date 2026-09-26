import { useEffect, useState } from "react";
import { Activity, Cpu, HardDrive, MemoryStick, RefreshCw, Server } from "lucide-react";
import { readSshResourceSample, type SshResourceSample } from "@/modules/ssh/bridge";

type Metrics = {
  cpu: number | null;
  memoryUsed: number;
  memoryTotal: number;
  networkReceivedRate: number | null;
  networkSentRate: number | null;
  filesystems: SshResourceSample["filesystems"];
};

function deltaRate(current: number, previous: number, seconds: number): number {
  return Math.max(0, current - previous) / seconds;
}

function toMetrics(
  current: SshResourceSample,
  previous: SshResourceSample | null,
  elapsedSeconds: number,
): Metrics {
  const cpuTotalDelta = previous ? current.cpuTotal - previous.cpuTotal : 0;
  const cpuIdleDelta = previous ? current.cpuIdle - previous.cpuIdle : 0;
  return {
    cpu:
      previous && cpuTotalDelta > 0
        ? Math.max(0, Math.min(100, (1 - cpuIdleDelta / cpuTotalDelta) * 100))
        : null,
    memoryUsed: Math.max(0, current.memoryTotal - current.memoryAvailable),
    memoryTotal: current.memoryTotal,
    networkReceivedRate: previous
      ? deltaRate(current.networkReceived, previous.networkReceived, elapsedSeconds)
      : null,
    networkSentRate: previous
      ? deltaRate(current.networkSent, previous.networkSent, elapsedSeconds)
      : null,
    filesystems: current.filesystems,
  };
}

function formatNetwork(bytesPerSecond: number | null): string {
  return bytesPerSecond === null ? "…" : `${((bytesPerSecond * 8) / 1_000_000).toFixed(2)} Mb/s`;
}

function gb(kib: number): string {
  return `${((kib * 1024) / 1_000_000_000).toFixed(2)} GB`;
}

function filesystemSizePair(usedKib: number, totalKib: number): string {
  const totalBytes = totalKib * 1024;
  const usedBytes = usedKib * 1024;
  const unit =
    totalBytes >= 1_000_000_000
      ? { divisor: 1_000_000_000, label: "GB", decimals: 1 }
      : totalBytes >= 1_000_000
        ? { divisor: 1_000_000, label: "MB", decimals: 0 }
        : { divisor: 1_000, label: "KB", decimals: 0 };
  return `${(usedBytes / unit.divisor).toFixed(unit.decimals)} / ${(totalBytes / unit.divisor).toFixed(unit.decimals)} ${unit.label}`;
}

function Segment({
  children,
  title,
  className = "",
  grow = false,
}: {
  children: React.ReactNode;
  title?: string;
  className?: string;
  grow?: boolean;
}) {
  return (
    <span
      title={title}
      className={`border-border/60 inline-flex h-5 items-center gap-1.5 border-r px-2 whitespace-nowrap last:border-r-0 ${grow ? "min-w-0 flex-1 overflow-hidden" : "shrink-0"} ${className}`}
    >
      {children}
    </span>
  );
}

function UsageGauge({ value }: { value: number | null }) {
  const percent = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <span className="bg-muted/80 h-1 w-7 shrink-0 overflow-hidden rounded-full" aria-hidden="true">
      <span
        className="bg-primary block h-full rounded-full transition-[width] duration-300"
        style={{ width: `${percent}%`, opacity: value === null ? 0.35 : 1 }}
      />
    </span>
  );
}

/** Persistent, compact SSH telemetry strip in the application status bar. */
export function SshResourceBar({
  sessionId,
  hostLabel,
}: {
  sessionId: number;
  hostLabel: string | null;
}) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let previous: { sample: SshResourceSample; at: number } | null = null;
    setMetrics(null);
    setError(null);

    const poll = async () => {
      try {
        const sample = await readSshResourceSample(sessionId);
        if (!active) return;
        const now = performance.now();
        setMetrics(
          toMetrics(sample, previous?.sample ?? null, previous ? (now - previous.at) / 1000 : 0),
        );
        previous = { sample, at: now };
        setError(null);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (active) timeout = setTimeout(() => void poll(), 5000);
    };

    void poll();
    return () => {
      active = false;
      if (timeout !== undefined) clearTimeout(timeout);
    };
  }, [sessionId]);

  return (
    <div
      role="status"
      aria-label="Remote system resource metrics"
      title={error ?? "Remote host metrics, refreshed every 5 seconds"}
      className="text-muted-foreground flex min-w-0 flex-1 items-center overflow-hidden text-[11px] tabular-nums"
    >
      <Segment title={hostLabel ?? "SSH host"} className="pl-1">
        <Server size={12} className="shrink-0" />
        <span className="text-foreground max-w-28 truncate font-medium">{hostLabel ?? "SSH"}</span>
      </Segment>
      {error ? (
        <Segment title={error} className="text-destructive">
          Metrics unavailable
        </Segment>
      ) : (
        <>
          <Segment title="CPU usage">
            <Cpu size={12} className="shrink-0" />
            <span className="text-muted-foreground text-[10px] font-medium">CPU</span>
            <span className="text-foreground min-w-[2.5ch] text-right">
              {metrics?.cpu === null || !metrics ? "…" : `${metrics.cpu.toFixed(0)}%`}
            </span>
            <UsageGauge value={metrics?.cpu ?? null} />
          </Segment>
          <Segment title="Memory used / total">
            <MemoryStick size={12} className="shrink-0" />
            <span className="text-muted-foreground text-[10px] font-medium">RAM</span>
            <span className="text-foreground">
              {metrics ? `${gb(metrics.memoryUsed)} / ${gb(metrics.memoryTotal)}` : "…"}
            </span>
            <UsageGauge
              value={
                metrics && metrics.memoryTotal > 0
                  ? (metrics.memoryUsed / metrics.memoryTotal) * 100
                  : null
              }
            />
          </Segment>
          <Segment title="Network received ↓ / sent ↑ throughput">
            <Activity size={12} className="shrink-0" />
            <span className="text-muted-foreground text-[10px] font-medium">NET</span>
            <span className="text-foreground">
              <span className="text-emerald-500">↓</span>{" "}
              {formatNetwork(metrics?.networkReceivedRate ?? null)}
            </span>
            <span className="text-foreground">
              <span className="text-sky-500">↑</span>{" "}
              {formatNetwork(metrics?.networkSentRate ?? null)}
            </span>
          </Segment>
          <Segment title="Metrics refresh interval">
            <RefreshCw size={11} className="shrink-0" />
            5s
          </Segment>
          <Segment
            title="Filesystem usage (hover a mount for used / total)"
            grow
            className="border-r-0"
          >
            <HardDrive size={12} className="shrink-0" />
            <span className="text-muted-foreground text-[10px] font-medium">FS</span>
            <span className="flex min-w-0 items-center gap-2 overflow-hidden">
              {metrics?.filesystems.map((fs) => (
                <span
                  key={fs.mount}
                  title={`${fs.mount}: ${gb(fs.usedKib)} used of ${gb(fs.totalKib)}`}
                  className="inline-flex min-w-0 shrink-0 items-center gap-1 whitespace-nowrap"
                >
                  <span className="text-muted-foreground max-w-16 truncate">{fs.mount}:</span>
                  <span className="text-foreground shrink-0">
                    {fs.totalKib > 0 ? Math.round((fs.usedKib / fs.totalKib) * 100) : 0}%
                  </span>
                  <span className="text-muted-foreground/60" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-foreground/75 shrink-0 text-[10px]">
                    {filesystemSizePair(fs.usedKib, fs.totalKib)}
                  </span>
                </span>
              ))}
            </span>
          </Segment>
        </>
      )}
    </div>
  );
}
