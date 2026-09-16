/**
 * A conflicted file, as Pierre's UnresolvedFile — ours/theirs picked per
 * region. Outside CodeView: a conflict is not a diff of two commits.
 */
import { useQuery } from "@tanstack/react-query";
import { UnresolvedFile } from "@pierre/diffs/react";

export function ConflictView(props: { repoPath: string; file: string }) {
  const conflict = useQuery<{ raw: string; conflicts: number }>({
    queryKey: ["git:conflict", props.repoPath, props.file],
    queryFn: () => window.hive.gitConflictedFile(props.repoPath, props.file),
  });
  if (conflict.isLoading) return <div className="px-3 py-2 text-[10px]">loading {props.file}…</div>;
  if (!conflict.data) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const UF = UnresolvedFile as any;
  return (
    <UF
      file={{
        name: props.file,
        contents: conflict.data.raw,
        cacheKey: `${props.repoPath}:CONFLICT:${props.file}:${conflict.data.conflicts}`,
      }}
      options={{ theme: { dark: "pierre-dark", light: "pierre-light" }, diffStyle: "split" }}
      onResolved={(resolved: string) => {
        void window.hive.gitWriteResolved(props.repoPath, props.file, resolved);
      }}
    />
  );
}
