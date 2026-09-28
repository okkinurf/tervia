import { useEffect, useState } from "react";
import { Activity, Clock, Cpu, HardDrive, MemoryStick, Server, Timer } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  startSshResourceStream,
  stopSshResourceStream,
  type SshResourceSample,
  type SshResourceStreamEvent,
} from "@/modules/ssh/bridge";

type Metrics = {
  hostname: string;
  version: string;
  uptimeSeconds: number;
  cpu: number | null;
  memoryUsed: number;
  memoryTotal: number;
  memoryAvailable: number;
  memoryCached: number;
  memoryBuffers: number;
  networkReceivedRate: number | null;
  networkSentRate: number | null;
  filesystems: SshResourceSample["filesystems"];
  networkInterfaces: (SshResourceSample["networkInterfaces"][number] & {
    receivedRate: number | null;
    sentRate: number | null;
  })[];
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
  const previousInterfaces = new Map(
    (previous?.networkInterfaces ?? []).map((iface) => [iface.name, iface]),
  );
  const networkInterfaces = current.networkInterfaces.map((iface) => {
    const prior = previousInterfaces.get(iface.name);
    return {
      ...iface,
      receivedRate: prior
        ? deltaRate(iface.receivedBytes, prior.receivedBytes, elapsedSeconds)
        : null,
      sentRate: prior ? deltaRate(iface.sentBytes, prior.sentBytes, elapsedSeconds) : null,
    };
  });
  const receivedRate = previous
    ? networkInterfaces.reduce((total, iface) => total + (iface.receivedRate ?? 0), 0)
    : null;
  const sentRate = previous
    ? networkInterfaces.reduce((total, iface) => total + (iface.sentRate ?? 0), 0)
    : null;
  return {
    hostname: current.hostname,
    version: current.version,
    uptimeSeconds: current.uptimeSeconds,
    cpu:
      previous && cpuTotalDelta > 0
        ? Math.max(0, Math.min(100, (1 - cpuIdleDelta / cpuTotalDelta) * 100))
        : null,
    memoryUsed: Math.max(0, current.memoryTotal - current.memoryAvailable),
    memoryTotal: current.memoryTotal,
    memoryAvailable: current.memoryAvailable,
    memoryCached: current.memoryCached,
    memoryBuffers: current.memoryBuffers,
    networkReceivedRate: receivedRate,
    networkSentRate: sentRate,
    filesystems: current.filesystems,
    networkInterfaces,
  };
}

function formatNetwork(bytesPerSecond: number | null): string {
  return bytesPerSecond === null ? "…" : `${((bytesPerSecond * 8) / 1_000_000).toFixed(2)} Mb/s`;
}

function formatNetworkCompact(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) return "…";
  const bitsPerSecond = bytesPerSecond * 8;
  if (bitsPerSecond < 100_000) return `${Math.round(bitsPerSecond / 1000)}K`;
  if (bitsPerSecond < 1_000_000) return `${(bitsPerSecond / 1000).toFixed(1)}K`;
  return `${(bitsPerSecond / 1_000_000).toFixed(bitsPerSecond < 10_000_000 ? 2 : 1)}M`;
}

function megabytes(kib: number): string {
  return `${Math.round(kib / 1024)} MB`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function compactFilesystemSizePair(usedKib: number, totalKib: number): string {
  return `${(usedKib / 976_562.5).toFixed(1)}/${(totalKib / 976_562.5).toFixed(1)}G`;
}

function formatUptime(seconds: number): string {
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}

function Segment({
  children,
  title,
  tooltip,
  tooltipClassName = "",
  className = "",
  grow = false,
}: {
  children: React.ReactNode;
  title?: string;
  tooltip?: React.ReactNode;
  tooltipClassName?: string;
  className?: string;
  grow?: boolean;
}) {
  const segment = (
    <span
      title={tooltip ? undefined : title}
      tabIndex={tooltip ? 0 : undefined}
      className={`border-border/60 inline-flex h-5 items-center gap-1 border-r px-1.5 whitespace-nowrap last:border-r-0 ${grow ? "min-w-0 flex-1 overflow-hidden" : "shrink-0"} ${className}`}
    >
      {children}
    </span>
  );
  if (!tooltip) return segment;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{segment}</TooltipTrigger>
      <TooltipContent side="top" align="start" className={tooltipClassName}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

function UsageGauge({ value }: { value: number | null }) {
  const percent = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <span className="bg-muted/80 h-1 w-5 shrink-0 overflow-hidden rounded-full" aria-hidden="true">
      <span
        className="bg-primary block h-full rounded-full transition-[width] duration-300"
        style={{ width: `${percent}%`, opacity: value === null ? 0.35 : 1 }}
      />
    </span>
  );
}

function MemoryDetails({ metrics }: { metrics: Metrics | null }) {
  const rows = metrics
    ? [
        ["Total RAM", megabytes(metrics.memoryTotal)],
        ["Used RAM", megabytes(metrics.memoryUsed)],
        ["Available RAM", megabytes(metrics.memoryAvailable)],
        ["Cached RAM", megabytes(metrics.memoryCached)],
        ["Buffers", megabytes(metrics.memoryBuffers)],
      ]
    : [["Memory details", "waiting for sample"]];
  return (
    <div className="min-w-44 space-y-0.5 font-mono text-[10px]">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[1fr_auto] gap-x-4">
          <span className="text-muted-foreground">{label}:</span>
          <span className="text-foreground text-right">{value}</span>
        </div>
      ))}
    </div>
  );
}

function NetworkDetails({ metrics }: { metrics: Metrics | null }) {
  if (!metrics?.networkInterfaces.length) {
    return <span className="font-mono text-[10px]">No network interfaces reported.</span>;
  }
  return (
    <div className="max-w-[min(560px,calc(100vw-32px))] space-y-2 font-mono text-[10px]">
      <div className="text-muted-foreground">Interface traffic counters (loopback excluded)</div>
      {metrics.networkInterfaces.map((iface) => (
        <div key={iface.name}>
          <div className="text-foreground mb-0.5 font-semibold">{iface.name}</div>
          <div className="grid grid-cols-[44px_1fr_1fr_42px_48px] gap-x-2">
            <span />
            <span className="text-muted-foreground text-right">Total</span>
            <span className="text-muted-foreground text-right">Rate</span>
            <span className="text-muted-foreground text-right">Errors</span>
            <span className="text-muted-foreground text-right">Dropped</span>
            <span className="text-diff-added">↓ In</span>
            <span className="text-foreground text-right">{formatBytes(iface.receivedBytes)}</span>
            <span className="text-foreground text-right">{formatNetwork(iface.receivedRate)}</span>
            <span className="text-foreground text-right">{iface.receivedErrors}</span>
            <span className="text-foreground text-right">{iface.receivedDropped}</span>
            <span className="text-info">↑ Out</span>
            <span className="text-foreground text-right">{formatBytes(iface.sentBytes)}</span>
            <span className="text-foreground text-right">{formatNetwork(iface.sentRate)}</span>
            <span className="text-foreground text-right">{iface.sentErrors}</span>
            <span className="text-foreground text-right">{iface.sentDropped}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function FilesystemDetails({ filesystems }: { filesystems: Metrics["filesystems"] | null }) {
  return (
    <div className="max-h-[min(65vh,540px)] w-[min(760px,calc(100vw-32px))] max-w-[calc(100vw-32px)] overflow-auto font-mono text-[10px]">
      <table className="w-full min-w-[600px] border-collapse text-left">
        <thead className="text-muted-foreground bg-popover sticky top-0">
          <tr>
            <th className="px-2 py-1 font-medium">Filesystem</th>
            <th className="px-2 py-1 text-right font-medium">1K-blocks</th>
            <th className="px-2 py-1 text-right font-medium">Used</th>
            <th className="px-2 py-1 text-right font-medium">Available</th>
            <th className="px-2 py-1 text-right font-medium">Use%</th>
            <th className="px-2 py-1 font-medium">Mounted on</th>
          </tr>
        </thead>
        <tbody>
          {filesystems?.map((fs, index) => (
            <tr key={`${fs.mount}:${fs.source}:${index}`} className="border-border/40 border-t">
              <td className="text-foreground max-w-48 truncate px-2 py-0.5" title={fs.source}>
                {fs.source}
              </td>
              <td className="text-foreground px-2 py-0.5 text-right">
                {formatBytes(fs.totalKib * 1024)}
              </td>
              <td className="text-foreground px-2 py-0.5 text-right">
                {formatBytes(fs.usedKib * 1024)}
              </td>
              <td className="text-foreground px-2 py-0.5 text-right">
                {formatBytes(fs.availableKib * 1024)}
              </td>
              <td className="text-foreground px-2 py-0.5 text-right">{fs.usePercent}%</td>
              <td className="text-foreground max-w-64 truncate px-2 py-0.5" title={fs.mount}>
                {fs.mount}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!filesystems?.length && (
        <div className="text-muted-foreground px-2 py-1">Filesystem data is not available yet.</div>
      )}
    </div>
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
  const [ping, setPing] = useState<{ host: string; latencyMs: number | null } | null>(null);
  const primaryFilesystem =
    metrics?.filesystems.find((fs) => fs.mount === "/") ?? metrics?.filesystems[0];

  useEffect(() => {
    let active = true;
    let previous: { sample: SshResourceSample; at: number } | null = null;
    const streamId = crypto.randomUUID();
    setMetrics(null);
    setError(null);
    setPing(null);

    const start = startSshResourceStream(sessionId, streamId, (event: SshResourceStreamEvent) => {
      if (!active) return;
      if (event.type === "ping") {
        setPing({ host: event.host, latencyMs: event.latencyMs });
        return;
      }
      if (event.type === "error") {
        setError(event.message);
        return;
      }
      const now = performance.now();
      setMetrics(
        toMetrics(
          event.sample,
          previous?.sample ?? null,
          previous ? (now - previous.at) / 1000 : 0,
        ),
      );
      previous = { sample: event.sample, at: now };
      setError(null);
    });
    void start.catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });

    return () => {
      active = false;
      void start.then(() => stopSshResourceStream(sessionId, streamId)).catch(() => undefined);
    };
  }, [sessionId]);

  return (
    <div
      role="status"
      aria-label="Remote system resource metrics"
      title={error ?? "Remote host metrics stream, sampling about once per second"}
      className="text-muted-foreground flex min-w-0 flex-1 items-center overflow-hidden text-[10px] tabular-nums"
    >
      <Segment
        title="VM name and SSH connection"
        tooltip={
          <div className="max-w-[min(720px,calc(100vw-32px))] space-y-1 font-mono text-[10px] break-words whitespace-pre-wrap">
            <div>
              <span className="text-muted-foreground">VM name: </span>
              <span className="text-foreground">{metrics?.hostname ?? hostLabel ?? "…"}</span>
            </div>
            <div>
              <span className="text-muted-foreground">SSH profile: </span>
              <span className="text-foreground">{hostLabel ?? "SSH"}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Version: </span>
              <span className="text-foreground">{metrics?.version ?? "Waiting for sample…"}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Monitor: </span>
              <span className="text-foreground">
                {metrics ? "Live · about 1 sample/sec" : "Waiting for first sample"}
              </span>
            </div>
          </div>
        }
        tooltipClassName="max-w-[min(720px,calc(100vw-32px))] whitespace-normal"
        className="pl-1"
      >
        <Server size={12} className="shrink-0" />
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${metrics ? "bg-icon-done" : "bg-muted-foreground/50"}`}
        />
        <span className="text-foreground max-w-20 truncate font-medium">
          {metrics?.hostname ?? hostLabel ?? "SSH"}
        </span>
      </Segment>
      {error ? (
        <Segment title={error} className="text-destructive">
          Metrics unavailable
        </Segment>
      ) : (
        <>
          <Segment
            title="CPU usage"
            tooltip={
              <span className="font-mono text-[10px]">
                Current CPU load:{" "}
                {metrics?.cpu == null ? "waiting for sample" : `${metrics.cpu.toFixed(0)}%`}
              </span>
            }
          >
            <Cpu size={12} className="shrink-0" />
            <span className="text-muted-foreground text-[9px] font-medium">CPU</span>
            <span className="text-foreground min-w-[2.5ch] text-right font-medium">
              {metrics?.cpu === null || !metrics ? "…" : `${metrics.cpu.toFixed(0)}%`}
            </span>
            <UsageGauge value={metrics?.cpu ?? null} />
          </Segment>
          <Segment title="Memory details" tooltip={<MemoryDetails metrics={metrics} />}>
            <MemoryStick size={12} className="shrink-0" />
            <span className="text-muted-foreground text-[9px] font-medium">RAM</span>
            <span className="text-foreground font-medium">
              {metrics
                ? `${(metrics.memoryUsed / 976_562.5).toFixed(2)}/${(metrics.memoryTotal / 976_562.5).toFixed(2)}G`
                : "…"}
            </span>
            <UsageGauge
              value={
                metrics && metrics.memoryTotal > 0
                  ? (metrics.memoryUsed / metrics.memoryTotal) * 100
                  : null
              }
            />
          </Segment>
          <Segment
            title="Network throughput and per-interface counters"
            tooltip={<NetworkDetails metrics={metrics} />}
            tooltipClassName="max-w-[min(560px,calc(100vw-32px))] whitespace-normal"
          >
            <Activity size={12} className="shrink-0" />
            <span className="text-muted-foreground text-[9px] font-medium">NET</span>
            <span className="text-foreground inline-flex items-center gap-1 font-medium">
              <span className="text-diff-added">↓</span>
              {formatNetworkCompact(metrics?.networkReceivedRate ?? null)}
              <span className="text-info">↑</span>
              {formatNetworkCompact(metrics?.networkSentRate ?? null)}
            </span>
          </Segment>
          <Segment
            title="Local ping to SSH server"
            tooltip={
              <div className="space-y-0.5 font-mono text-[10px]">
                <div>
                  Local ICMP ping to {ping?.host ?? "the SSH server"}:{" "}
                  {ping
                    ? ping.latencyMs === null
                      ? "no reply"
                      : `${ping.latencyMs < 1 ? "<1" : ping.latencyMs.toFixed(ping.latencyMs < 10 ? 1 : 0)} ms`
                    : "waiting for first ping"}
                </div>
                <div className="text-muted-foreground">
                  Measured from this computer. No reply can mean ICMP is blocked or the server is
                  reachable only through a proxy.
                </div>
              </div>
            }
          >
            <Timer size={12} className="shrink-0" />
            <span className="text-muted-foreground text-[9px] font-medium">PING</span>
            <span className="text-foreground font-medium">
              {ping
                ? ping.latencyMs === null
                  ? "—"
                  : `${ping.latencyMs < 1 ? "<1" : ping.latencyMs.toFixed(ping.latencyMs < 10 ? 1 : 0)}ms`
                : "…"}
            </span>
          </Segment>
          <Segment
            title="Remote host uptime"
            tooltip={
              <div className="space-y-0.5 font-mono text-[10px]">
                <div>
                  Uptime:{" "}
                  {metrics ? `${metrics.uptimeSeconds.toFixed(2)} sec` : "waiting for sample"}
                </div>
                <div className="text-muted-foreground">
                  Samples arrive about once per second over a persistent SSH channel.
                </div>
              </div>
            }
          >
            <Clock size={12} className="shrink-0" />
            <span className="text-muted-foreground text-[9px] font-medium">UP</span>
            <span className="text-foreground font-medium">
              {metrics ? formatUptime(metrics.uptimeSeconds) : "…"}
            </span>
          </Segment>
          <Segment
            title="All mounted filesystems"
            tooltip={<FilesystemDetails filesystems={metrics?.filesystems ?? null} />}
            tooltipClassName="max-w-[calc(100vw-24px)] p-2"
            grow
            className="border-r-0"
          >
            <HardDrive size={12} className="shrink-0" />
            <span className="text-muted-foreground text-[9px] font-medium">FS</span>
            <span className="flex min-w-0 items-center gap-1 overflow-hidden">
              {primaryFilesystem ? (
                <>
                  <span className="text-muted-foreground max-w-12 truncate">
                    {primaryFilesystem.mount}
                  </span>
                  <span className="text-foreground font-medium">
                    {primaryFilesystem.usePercent}%
                  </span>
                  <span className="text-foreground/75">
                    {compactFilesystemSizePair(
                      primaryFilesystem.usedKib,
                      primaryFilesystem.totalKib,
                    )}
                  </span>
                </>
              ) : (
                <span>…</span>
              )}
            </span>
          </Segment>
        </>
      )}
    </div>
  );
}
