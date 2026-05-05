import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChapterSummary, ProjectSummary, QualityReport } from '../types/dashboard';
import { QualityReportFilters, useQualityReportActions } from '../hooks/useContinuityActions';

const VERDICTS = ['pass', 'warn', 'fail'];
const SOURCE_TYPES = ['generation', 'validation', 'ai_review', 'auto_repair', 'manual'];
const REPORT_TYPES = ['generation_quality_gate', 'validation', 'ai_review', 'auto_repair', 'manual'];

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
  selectedChapterId: string;
  chapters: ChapterSummary[];
}

export function QualityReportPanel({ selectedProject, selectedProjectId, selectedChapterId, chapters }: Props) {
  const initialChapterFilter = selectedChapterId && selectedChapterId !== 'all' ? selectedChapterId : 'all';
  const [chapterFilter, setChapterFilter] = useState(initialChapterFilter);
  const [draftIdFilter, setDraftIdFilter] = useState('');
  const [sourceTypeFilter, setSourceTypeFilter] = useState('all');
  const [reportTypeFilter, setReportTypeFilter] = useState('all');
  const [verdictFilter, setVerdictFilter] = useState('all');

  const { qualityReports, loading, error, setError, loadQualityReports, deleteQualityReport } = useQualityReportActions(selectedProjectId);

  useEffect(() => {
    setChapterFilter(initialChapterFilter);
    setDraftIdFilter('');
    setSourceTypeFilter('all');
    setReportTypeFilter('all');
    setVerdictFilter('all');
    setError('');
  }, [initialChapterFilter, selectedProjectId, setError]);

  const filters = useMemo<QualityReportFilters>(() => ({
    chapterId: chapterFilter,
    draftId: draftIdFilter.trim(),
    sourceType: sourceTypeFilter,
    reportType: reportTypeFilter,
    verdict: verdictFilter,
  }), [chapterFilter, draftIdFilter, reportTypeFilter, sourceTypeFilter, verdictFilter]);

  useEffect(() => {
    if (selectedProjectId) {
      void loadQualityReports(filters);
    }
  }, [filters, loadQualityReports, selectedProjectId]);

  const chapterById = useMemo(() => new Map(chapters.map((chapter) => [chapter.id, chapter])), [chapters]);
  const verdictOptions = useMemo(() => mergeOptions(VERDICTS, qualityReports.map((item) => item.verdict)), [qualityReports]);
  const sourceTypeOptions = useMemo(() => mergeOptions(SOURCE_TYPES, qualityReports.map((item) => item.sourceType)), [qualityReports]);
  const reportTypeOptions = useMemo(() => mergeOptions(REPORT_TYPES, qualityReports.map((item) => item.reportType)), [qualityReports]);

  const stats = useMemo(() => qualityReports.reduce((result, report) => {
    result.issueCount += safeArray(report.issues).length;
    result.failCount += report.verdict === 'fail' ? 1 : 0;
    result.warnCount += report.verdict === 'warn' ? 1 : 0;
    return result;
  }, { issueCount: 0, failCount: 0, warnCount: 0 }), [qualityReports]);

  const hasFilters = chapterFilter !== 'all' || Boolean(draftIdFilter.trim()) || sourceTypeFilter !== 'all' || reportTypeFilter !== 'all' || verdictFilter !== 'all';

  const refresh = useCallback(() => {
    void loadQualityReports(filters);
  }, [filters, loadQualityReports]);

  const resetFilters = () => {
    setChapterFilter('all');
    setDraftIdFilter('');
    setSourceTypeFilter('all');
    setReportTypeFilter('all');
    setVerdictFilter('all');
    setError('');
  };

  const removeReport = async (report: QualityReport) => {
    if (!window.confirm(`Delete quality report ${report.reportType} / ${report.verdict}?`)) return;
    const deleted = await deleteQualityReport(report.id);
    if (deleted) {
      await loadQualityReports(filters);
    }
  };

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <header className="flex items-center justify-between shrink-0" style={{ height: '3.5rem', background: 'var(--bg-editor-header)', padding: '0 2rem', borderBottom: '1px solid var(--border-light)', backdropFilter: 'blur(12px)', zIndex: 10 }}>
        <div className="flex items-center gap-3">
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#0ea5e9', boxShadow: '0 0 10px rgba(14,165,233,0.5)' }} />
          <h1 className="text-lg font-bold text-heading">质量报告</h1>
          <span className="badge" style={{ background: 'rgba(14,165,233,0.12)', color: '#38bdf8', border: 'none' }}>Quality</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>{selectedProject?.title ?? '未选择项目'}</span>
          <button className="btn-secondary" onClick={refresh} disabled={loading || !selectedProjectId} style={{ fontSize: '0.75rem' }}>刷新</button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0" style={{ padding: '0.75rem 2rem', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-card)' }}>
        <div className="flex flex-wrap items-center gap-2">
          <select className="input-field" value={chapterFilter} onChange={(event) => setChapterFilter(event.target.value)} style={filterStyle}>
            <option value="all">全部章节</option>
            {chapters.map((chapter) => (
              <option key={chapter.id} value={chapter.id}>Ch.{chapter.chapterNo} {chapter.title ?? ''}</option>
            ))}
          </select>
          <input className="input-field" value={draftIdFilter} onChange={(event) => setDraftIdFilter(event.target.value)} placeholder="Draft ID" style={{ ...filterStyle, width: '12rem' }} />
          <SelectFilter value={sourceTypeFilter} options={sourceTypeOptions} allLabel="全部来源" onChange={setSourceTypeFilter} />
          <SelectFilter value={reportTypeFilter} options={reportTypeOptions} allLabel="全部类型" onChange={setReportTypeFilter} />
          <SelectFilter value={verdictFilter} options={verdictOptions} allLabel="全部结论" onChange={setVerdictFilter} width="8rem" />
          {hasFilters ? (
            <button className="btn-secondary" onClick={resetFilters} disabled={loading} style={{ fontSize: '0.75rem', padding: '0.45rem 0.75rem' }}>清空筛选</button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MiniStat label="报告" value={qualityReports.length} color="#38bdf8" />
          <MiniStat label="问题" value={stats.issueCount} color="#f59e0b" />
          <MiniStat label="警告" value={stats.warnCount} color="#fbbf24" />
          <MiniStat label="失败" value={stats.failCount} color="#fb7185" />
        </div>
      </div>

      <div className="flex-1 min-h-0" style={{ overflowY: 'auto', padding: '1.25rem 1.5rem' }}>
        {error ? (
          <div className="mb-3 text-sm" style={{ color: 'var(--status-err)', background: 'var(--status-err-bg)', borderRadius: '0.75rem', padding: '0.75rem 1rem', border: '1px solid rgba(244,63,94,0.25)' }}>
            {error}
          </div>
        ) : null}

        {!selectedProjectId ? (
          <div className="list-card-empty">请先选择项目</div>
        ) : loading ? (
          <div className="list-card-empty">质量报告加载中...</div>
        ) : qualityReports.length === 0 ? (
          <div className="list-card-empty">{hasFilters ? '当前筛选下暂无质量报告。' : '暂无质量报告。'}</div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(22rem, 1fr))' }}>
            {qualityReports.map((report) => (
              <ReportCard
                key={report.id}
                report={report}
                chapter={report.chapterId ? chapterById.get(report.chapterId) : undefined}
                onDelete={removeReport}
              />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

const filterStyle = { width: '10rem', fontSize: '0.75rem', padding: '0.45rem 0.75rem' };

function SelectFilter({ value, options, allLabel, width = '10rem', onChange }: { value: string; options: string[]; allLabel: string; width?: string; onChange: (value: string) => void }) {
  return (
    <select className="input-field" value={value} onChange={(event) => onChange(event.target.value)} style={{ ...filterStyle, width }}>
      <option value="all">{allLabel}</option>
      {options.map((option) => (
        <option key={option} value={option}>{option}</option>
      ))}
    </select>
  );
}

function ReportCard({ report, chapter, onDelete }: { report: QualityReport; chapter?: ChapterSummary; onDelete: (report: QualityReport) => void }) {
  const scores = Object.entries(safeRecord(report.scores)).slice(0, 8);
  const issues = safeArray(report.issues);

  return (
    <section className="panel flex flex-col" style={{ overflow: 'hidden', minWidth: 0 }}>
      <div className="p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
        <div className="flex items-start justify-between gap-3">
          <div style={{ minWidth: 0 }}>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="badge" style={getVerdictStyle(report.verdict)}>{report.verdict}</span>
              <span className="badge" style={{ fontSize: '0.62rem' }}>{report.reportType}</span>
              <span className="badge" style={{ fontSize: '0.62rem' }}>{report.sourceType}</span>
              {chapter ? <span className="badge" style={{ fontSize: '0.62rem' }}>Ch.{chapter.chapterNo}</span> : null}
            </div>
            <h2 className="text-base font-bold text-heading truncate">{report.summary || `${report.reportType} 质量报告`}</h2>
          </div>
          <button className="btn-danger" onClick={() => onDelete(report)} style={{ fontSize: '0.72rem', padding: '0.45rem 0.7rem', flexShrink: 0 }}>删除</button>
        </div>

        <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))' }}>
          <MetaItem label="创建时间" value={formatDate(report.createdAt)} />
          <MetaItem label="sourceId" value={shortId(report.sourceId)} />
          <MetaItem label="draftId" value={shortId(report.draftId)} />
          <MetaItem label="agentRun" value={shortId(report.agentRunId)} />
        </div>
      </div>

      <div className="p-4 space-y-3">
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-bold" style={{ color: 'var(--text-muted)' }}>评分</h3>
            <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{scores.length} 项</span>
          </div>
          {scores.length ? (
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))' }}>
              {scores.map(([key, value]) => (
                <div key={key} className="stat-card" style={{ padding: '0.65rem', borderRadius: '0.5rem' }}>
                  <div className="stat-card__label" style={{ textTransform: 'none', letterSpacing: 0 }}>{key}</div>
                  <div className="text-sm font-bold mt-1" style={{ color: scoreColor(value), wordBreak: 'break-word' }}>{formatUnknown(value)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm" style={{ color: 'var(--text-dim)' }}>无评分数据</div>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-bold" style={{ color: 'var(--text-muted)' }}>问题列表</h3>
            <span className="text-xs" style={{ color: issues.length ? '#f59e0b' : 'var(--text-dim)' }}>{issues.length} 条</span>
          </div>
          {issues.length ? (
            <div className="space-y-2">
              {issues.slice(0, 8).map((issue, index) => (
                <IssueRow key={`${report.id}-issue-${index}`} issue={issue} index={index} />
              ))}
              {issues.length > 8 ? (
                <div className="text-xs" style={{ color: 'var(--text-dim)' }}>还有 {issues.length - 8} 条问题未展开。</div>
              ) : null}
            </div>
          ) : (
            <div className="text-sm" style={{ color: 'var(--text-dim)' }}>未记录问题</div>
          )}
        </section>
      </div>
    </section>
  );
}

function IssueRow({ issue, index }: { issue: unknown; index: number }) {
  const record = asRecord(issue);
  const severity = record ? readString(record.severity) || readString(record.level) : '';
  const title = getIssueTitle(issue, index);
  const detail = record ? readString(record.suggestion) || readString(record.detail) || readString(record.description) : '';

  return (
    <div className="list-card" style={{ padding: '0.75rem', borderRadius: '0.65rem' }}>
      <div className="flex flex-wrap items-center gap-2">
        {severity ? <span className="badge" style={getSeverityStyle(severity)}>{severity}</span> : null}
        <strong className="text-sm" style={{ color: 'var(--text-main)' }}>{title}</strong>
      </div>
      {detail ? <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)', lineHeight: 1.6 }}>{detail}</p> : null}
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span className="stat-card" style={{ padding: '0.45rem 0.65rem', borderRadius: '0.5rem' }}>
      <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{label}</span>
      <strong className="text-sm ml-2" style={{ color }}>{value}</strong>
    </span>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="text-xs" style={{ color: 'var(--text-dim)' }}>{label}</div>
      <div className="text-xs font-medium truncate" style={{ color: 'var(--text-muted)' }}>{value || '-'}</div>
    </div>
  );
}

function mergeOptions(base: string[], extra: Array<string | null | undefined>) {
  return Array.from(new Set([...base, ...extra.map((item) => item?.trim() ?? '')])).filter(Boolean);
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function getIssueTitle(issue: unknown, index: number) {
  if (typeof issue === 'string') return issue;
  const record = asRecord(issue);
  if (!record) return `问题 ${index + 1}`;

  return readString(record.message)
    || readString(record.summary)
    || readString(record.title)
    || readString(record.issueType)
    || readString(record.type)
    || compactJson(record);
}

function formatUnknown(value: unknown) {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value == null) return '-';
  return compactJson(value);
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function scoreColor(value: unknown) {
  if (typeof value !== 'number') return 'var(--text-main)';
  if (value >= 80 || (value > 0.8 && value <= 1)) return '#34d399';
  if (value >= 60 || (value > 0.6 && value <= 1)) return '#fbbf24';
  return '#fb7185';
}

function getVerdictStyle(verdict: string) {
  if (verdict === 'pass') return { borderColor: 'rgba(16,185,129,0.4)', background: 'rgba(16,185,129,0.1)', color: '#34d399' };
  if (verdict === 'warn') return { borderColor: 'rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.1)', color: '#fbbf24' };
  if (verdict === 'fail') return { borderColor: 'rgba(244,63,94,0.4)', background: 'var(--status-err-bg)', color: '#fb7185' };
  return { borderColor: 'var(--border-dim)', background: 'var(--bg-overlay)', color: 'var(--text-muted)' };
}

function getSeverityStyle(severity: string) {
  if (['error', 'critical', 'fail', 'blocker'].includes(severity)) return getVerdictStyle('fail');
  if (['warning', 'warn'].includes(severity)) return getVerdictStyle('warn');
  if (['info', 'pass', 'ok'].includes(severity)) return getVerdictStyle('pass');
  return getVerdictStyle('');
}

function shortId(value?: string | null) {
  if (!value) return '-';
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
