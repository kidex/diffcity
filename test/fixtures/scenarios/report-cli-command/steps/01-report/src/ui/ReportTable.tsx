export interface ReportRow {
  name: string;
  runs: number;
}

export function ReportTable({ rows }: { rows: ReportRow[] }) {
  return (
    <table>
      <tbody>
        {rows.map((row) => (
          <ReportLine key={row.name} row={row} />
        ))}
      </tbody>
    </table>
  );
}

export const ReportLine = ({ row }: { row: ReportRow }) => (
  <tr>
    <td>{row.name}</td>
    <td>{row.runs}</td>
  </tr>
);
