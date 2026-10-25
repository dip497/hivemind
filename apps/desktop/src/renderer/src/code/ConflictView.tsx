/**
 * A conflicted file, as Pierre's UnresolvedFile — ours/theirs picked per
 * region. Outside CodeView: a conflict is not a diff of two commits.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { UnresolvedFile } from "@pierre/diffs/react";
import { PIERRE_OPTIONS } from "../pierre-codeview";
import { useThemeField } from "../theme-store";

export function ConflictView(props: { repoPath: string; file: string }) {
  const themeType = useThemeField("mode");
  const options = useMemo(() => ({ ...PIERRE_OPTIONS, themeType, diffStyle: "split" }) as const, [themeType]);
  const conflict = useQuery<{ raw: string; conflicts: number }>({
    queryKey: ["git:conflict", props.repoPath, props.file],
    queryFn: () => window.hive.gitConflictedFile(props.repoPath, props.file),
  });
  const data = conflict.data;
  // Stable identity — a fresh file object on an unrelated render restarts it.
  const file = useMemo(
    () => (data
      ? { name: props.file, contents: data.raw, cacheKey: `${props.repoPath}:CONFLICT:${props.file}:${data.conflicts}` }
      : null),
    [data, props.file, props.repoPath],
  );
  if (conflict.isLoading) return <div className="px-3 py-2 text-chip">loading {props.file}…</div>;
  if (!file) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const UF = UnresolvedFile as any;
  return (
    <UF
      file={file}
      options={options}
      onResolved={(resolved: string) => {
        void window.hive.gitWriteResolved(props.repoPath, props.file, resolved);
      }}
    />
  );
}
