// Shared model/effort/outcome table for product host windows and legacy diagnostic samples.
// Token fields have independent coverage; missing measurements never render as zero.
import type { UsageTurnBreakdown } from "./api";
import { EmptyLine, TableWrap } from "./components";

const measured = (total: number | null | undefined, samples: number | undefined) =>
  samples !== undefined && samples > 0 && typeof total === "number"
    ? total.toLocaleString()
    : "Unknown";

export function TurnBreakdownTable({
  rows,
  legacy = false,
}: {
  rows: readonly UsageTurnBreakdown[];
  legacy?: boolean;
}) {
  if (rows.length === 0) return <EmptyLine text="No captured turn details in range." />;
  return (
    <TableWrap>
      <table className="data">
        <caption className="visually-hidden">
          {legacy ? "Legacy sampled" : "Captured host"} turns by provider, model, effort and mode
        </caption>
        <thead>
          <tr>
            <th scope="col">Recorded provider / model</th>
            <th scope="col">Requested effort</th>
            <th scope="col">Mode</th>
            <th scope="col">Permissions</th>
            <th scope="col">Started by</th>
            <th scope="col" className="num">
              Completed
            </th>
            <th scope="col" className="num">
              Failed
            </th>
            <th scope="col" className="num">
              Cancelled
            </th>
            <th scope="col" className="num">
              Mean time
            </th>
            <th scope="col" className="num">
              Measured tokens: in / out / cached
            </th>
            <th scope="col" className="num">
              Token samples: in / out / cached
            </th>
            {legacy && (
              <th scope="col" className="num">
                Installations
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={[
                row.provider,
                row.model,
                row.effort,
                row.interactionMode,
                row.runtimeMode,
                row.origin,
              ].join("|")}
            >
              <td>
                {row.provider} / {row.model}
              </td>
              <td>{row.effort}</td>
              <td>{row.interactionMode}</td>
              <td>{row.runtimeMode}</td>
              <td>{row.origin}</td>
              <td className="num">{row.succeeded.toLocaleString()}</td>
              <td className="num">{row.failed.toLocaleString()}</td>
              <td className="num">{row.cancelled.toLocaleString()}</td>
              <td className="num">
                {row.meanDurationMs === null
                  ? "Unknown"
                  : `${Math.round(row.meanDurationMs / 100) / 10} s`}
              </td>
              <td className="num">
                {measured(row.inputTokens, row.inputSamples)} /{" "}
                {measured(row.outputTokens, row.outputSamples)} /{" "}
                {measured(row.cachedInputTokens, row.cachedInputSamples)}
              </td>
              <td className="num">
                {row.inputSamples ?? "Unknown"} / {row.outputSamples ?? "Unknown"} /{" "}
                {row.cachedInputSamples ?? "Unknown"}
              </td>
              {legacy && <td className="num">{row.installs}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}
