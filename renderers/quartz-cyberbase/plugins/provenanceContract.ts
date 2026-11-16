// Renderer-neutral, versioned emission boundary. No Quartz, filesystem or DOM APIs.
export type SourceIdentity = {
  path: string;
  byteLength: number;
  sha256: string;
};
export type ProvenanceRun = {
  rendered: [number, number]; // UTF-16 offsets in the unnormalized DOM Text.data
  source?: [number, number]; // half-open UTF-8 bytes, complete Unicode boundaries
  kind?: "exact" | "atom";
  reason?: string;
};
export type ProvenanceLeaf = {
  id: string;
  parent: string; // data-cb-node, or "$body" for the source body root
  child: number; // childNodes index, not element.children index
  text: string; // browser must compare exactly before using any run
  runs: ProvenanceRun[];
  exact?: [number, number]; // present only when the entire text is one exact source slice
};
export type ProvenanceManifest = {
  schema: "cyberbaser.source-provenance";
  version: 1;
  source: SourceIdentity;
  leaves: ProvenanceLeaf[];
};
export interface ProvenanceSink {
  write(page: string, manifest: ProvenanceManifest): void;
}
export function emitProvenance(
  sink: ProvenanceSink,
  page: string,
  source: SourceIdentity,
  leaves: ProvenanceLeaf[],
) {
  const manifest: ProvenanceManifest = {
    schema: "cyberbaser.source-provenance",
    version: 1,
    source,
    leaves,
  };
  sink.write(page, manifest);
  return manifest;
}
