export interface SourceRefreshProgress {
  source_id: number;
  stage: string;
  stage_label: string;
  percent: number | null;
  indeterminate: boolean;
  current?: number;
  total?: number;
  error?: string;
}
