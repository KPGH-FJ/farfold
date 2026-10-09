import type { ReportedDetails as Fields } from "../runtime/reported_details";
import { SearchDisclosure } from "./transcript-search";

export const REPORTED_DETAILS_STRINGS = {
  title: "最近收到的扩展字段",
  note: "按字段保留最近收到的值；这里不是完整消息，也不表示额外功能已生效。",
} as const;

export function ReportedDetails({ details }: { details?: Fields }) {
  if (!details || Object.keys(details).length === 0) return null;
  return (
    <SearchDisclosure className="raw-block">
      <summary>{REPORTED_DETAILS_STRINGS.title}</summary>
      <p>{REPORTED_DETAILS_STRINGS.note}</p>
      <pre data-find-block>{JSON.stringify(details, null, 2)}</pre>
    </SearchDisclosure>
  );
}
