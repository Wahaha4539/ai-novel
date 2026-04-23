import React from 'react';
import { GUIDED_STEPS, StepKey } from '../../hooks/useGuidedSession';

/** Volume info parsed from guided_volume step */
interface VolumeInfo {
  volumeNo: number;
  title: string;
}

/** Chapter info parsed from guided_chapter step */
interface ChapterInfo {
  chapterNo: number;
  title: string;
}

interface Props {
  activeStepKey: StepKey;
  completedSteps: Set<string>;
  onStepClick: (stepKey: StepKey) => void;
  volumeData?: Record<string, unknown>;
  chapterData?: Record<string, unknown>;
}

/** Parse volumes array from step data */
function parseVolumes(data: Record<string, unknown>): VolumeInfo[] {
  const raw = data?.volumes;
  if (!raw) return [];
  try {
    if (typeof raw === 'string') return JSON.parse(raw) as VolumeInfo[];
    if (Array.isArray(raw)) return raw as VolumeInfo[];
  } catch { /* ignore */ }
  return [];
}

/** Parse volumeChapters map from chapter step data */
function parseVolumeChapters(data: Record<string, unknown>): Record<number, ChapterInfo[]> {
  const raw = data?.volumeChapters;
  if (!raw) return {};
  try {
    if (typeof raw === 'string') return JSON.parse(raw) as Record<number, ChapterInfo[]>;
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<number, ChapterInfo[]>;
  } catch { /* ignore */ }
  return {};
}

export function DocumentTOC({ activeStepKey, completedSteps, onStepClick, volumeData, chapterData }: Props) {
  const volumes = volumeData ? parseVolumes(volumeData) : [];
  const volumeChapters = chapterData ? parseVolumeChapters(chapterData) : {};

  return (
    <nav className="doc-toc">
      <div
        style={{
          padding: '0 1rem 0.75rem',
          marginBottom: '0.5rem',
          borderBottom: '1px solid var(--border-dim)',
        }}
      >
        <div
          style={{
            fontSize: '0.65rem',
            fontWeight: 700,
            color: 'var(--text-dim)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          文档目录
        </div>
      </div>

      {GUIDED_STEPS.map((step) => {
        const isActive = step.key === activeStepKey;
        const isCompleted = completedSteps.has(step.key);

        const itemClass = [
          'doc-toc__item',
          isActive ? 'doc-toc__item--active' : '',
          isCompleted && !isActive ? 'doc-toc__item--completed' : '',
        ]
          .filter(Boolean)
          .join(' ');

        const dotBg = isActive
          ? step.color
          : isCompleted
            ? step.color
            : 'var(--border-light)';

        const dotShadow = isActive ? `0 0 6px ${step.color}66` : 'none';

        return (
          <div key={step.key}>
            <button
              className={itemClass}
              onClick={() => onStepClick(step.key)}
            >
              <span
                className="doc-toc__dot"
                style={{ background: dotBg, boxShadow: dotShadow }}
              />
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                {isCompleted && !isActive ? '✓' : step.icon}
                <span>{step.label}</span>
              </span>
            </button>

            {/* Show volume/chapter tree under 章节细纲 */}
            {step.key === 'guided_chapter' && volumes.length > 0 && (
              <ChapterTree volumes={volumes} volumeChapters={volumeChapters} />
            )}
          </div>
        );
      })}
    </nav>
  );
}

/** Tree showing volumes and their chapters under the chapter step */
function ChapterTree({
  volumes,
  volumeChapters,
}: {
  volumes: VolumeInfo[];
  volumeChapters: Record<number, ChapterInfo[]>;
}) {
  const hasAnyChapters = Object.values(volumeChapters).some((chs) => chs.length > 0);
  if (!hasAnyChapters && volumes.length === 0) return null;

  return (
    <div
      style={{
        marginLeft: '1.2rem',
        paddingLeft: '0.6rem',
        borderLeft: '1px solid var(--border-dim)',
        marginBottom: '0.25rem',
      }}
    >
      {volumes.map((vol) => {
        const chapters = volumeChapters[vol.volumeNo] ?? [];
        return (
          <div key={vol.volumeNo} style={{ marginBottom: '0.15rem' }}>
            {/* Volume label */}
            <div
              style={{
                fontSize: '0.68rem',
                fontWeight: 600,
                color: '#14b8a6',
                padding: '0.15rem 0',
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
              }}
            >
              <span
                style={{
                  width: '5px',
                  height: '5px',
                  borderRadius: '50%',
                  background: chapters.length > 0 ? '#34d399' : '#14b8a6',
                  display: 'inline-block',
                  flexShrink: 0,
                }}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                第{vol.volumeNo}卷 {vol.title || ''}
              </span>
              {chapters.length > 0 && (
                <span
                  style={{
                    fontSize: '0.58rem',
                    color: '#34d399',
                    background: 'rgba(16,185,129,0.1)',
                    padding: '0 0.25rem',
                    borderRadius: '0.15rem',
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  {chapters.length}章
                </span>
              )}
            </div>

            {/* Chapter items */}
            {chapters.length > 0 && (
              <div style={{ marginLeft: '0.6rem', paddingLeft: '0.4rem', borderLeft: '1px solid var(--border-dim)' }}>
                {chapters.map((ch, idx) => (
                  <div
                    key={idx}
                    style={{
                      fontSize: '0.64rem',
                      color: 'var(--text-dim)',
                      padding: '0.08rem 0',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{ opacity: 0.5, marginRight: '0.2rem' }}>#{ch.chapterNo}</span>
                    {ch.title || '未命名'}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
