import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { ScoringController } from './scoring.controller';
import { ScoringService } from './scoring.service';
import { ScoringTargetLoaderService } from './scoring-target-loader.service';

function completeCraftBrief() {
  return {
    visibleGoal: 'Find the ledger clue',
    hiddenEmotion: 'Distrust the companion',
    coreConflict: 'Gatekeeper blocks the investigation',
    mainlineTask: 'Confirm the lost-account lead',
    subplotTasks: ['Test companion loyalty'],
    storyUnit: {
      unitId: 'v1_unit_01',
      title: 'Market pursuit',
      chapterRange: { start: 1, end: 3 },
      chapterRole: 'opening chase',
      localGoal: 'Get the clue',
      localConflict: 'The market refuses outsiders',
      serviceFunctions: ['mainline'],
      mainlineContribution: 'Ledger exists',
      characterContribution: 'Protagonist becomes cautious',
      relationshipContribution: 'Trust cracks',
      worldOrThemeContribution: 'Market rules appear',
      unitPayoff: 'Ledger page appears',
      stateChangeAfterUnit: 'Protagonist is exposed',
    },
    actionBeats: ['Reach the gate', 'Negotiate with guard', 'Take the clue'],
    sceneBeats: [
      {
        sceneArcId: 's1',
        scenePart: 'entry',
        location: 'rain gate',
        participants: ['protagonist'],
        localGoal: 'enter',
        visibleAction: 'shows a token',
        obstacle: 'guard asks for the code',
        turningPoint: 'companion gives half-code',
        partResult: 'entry granted',
        sensoryAnchor: 'rain on iron',
      },
    ],
    characterExecution: {
      povCharacter: 'protagonist',
      cast: [{ characterName: 'protagonist', source: 'existing', functionInChapter: 'investigate', visibleGoal: 'find clue', pressure: 'watched', actionBeatRefs: [1], sceneBeatRefs: ['s1'], entryState: 'anxious', exitState: 'alert' }],
      relationshipBeats: [],
      newMinorCharacters: [],
    },
    concreteClues: [{ name: 'ledger page', sensoryDetail: 'wet paper', laterUse: 'points to account room' }],
    dialogueSubtext: 'companion knows the code',
    characterShift: 'protagonist distrusts companion',
    irreversibleConsequence: 'market identifies protagonist',
    progressTypes: ['info'],
    entryState: 'no clue',
    exitState: 'has page and is hunted',
    openLoops: ['where is the ledger'],
    closedLoops: ['missing person used market'],
    handoffToNextChapter: 'follow the red seal',
    continuityState: {
      nextImmediatePressure: 'guards pursue',
      characterPositions: ['protagonist in alley'],
      activeThreats: ['market guards'],
      ownedClues: ['ledger page'],
      relationshipChanges: ['distrust grows'],
    },
  };
}

async function run() {
  {
    const loader = new ScoringTargetLoaderService({
      project: {
        findUnique: async () => ({
          id: 'project-1',
          title: 'Project',
          outline: 'full outline',
          updatedAt: new Date('2026-05-16T00:00:00.000Z'),
        }),
      },
      volume: {
        findMany: async () => [
          { id: 'volume-1', volumeNo: 1, title: 'Volume 1', synopsis: 'synopsis', objective: null, narrativePlan: {}, chapterCount: 20, updatedAt: new Date('2026-05-16T00:00:00.000Z') },
          { id: 'volume-2', volumeNo: 2, title: 'Volume 2', synopsis: '', objective: '', narrativePlan: {}, chapterCount: null, updatedAt: new Date('2026-05-16T00:00:00.000Z') },
        ],
      },
      chapter: {
        findMany: async () => [
          { id: 'chapter-1', chapterNo: 1, title: 'Chapter 1', objective: 'goal', outline: 'outline', craftBrief: completeCraftBrief(), updatedAt: new Date('2026-05-16T00:00:00.000Z'), volume: { volumeNo: 1 } },
          { id: 'chapter-2', chapterNo: 2, title: 'Chapter 2', objective: '', outline: '', craftBrief: {}, updatedAt: new Date('2026-05-16T00:00:00.000Z'), volume: { volumeNo: 1 } },
        ],
      },
      chapterDraft: {
        findMany: async () => [
          { id: 'draft-1', versionNo: 2, content: 'draft content', source: 'generation', createdAt: new Date('2026-05-16T00:00:00.000Z'), chapter: { id: 'chapter-1', chapterNo: 1, title: 'Chapter 1', outline: 'outline', craftBrief: completeCraftBrief(), volume: { volumeNo: 1 } } },
          { id: 'draft-2', versionNo: 1, content: '', source: 'generation', createdAt: new Date('2026-05-16T00:00:00.000Z'), chapter: { id: 'chapter-2', chapterNo: 2, title: 'Chapter 2', outline: '', craftBrief: {}, volume: { volumeNo: 1 } } },
        ],
      },
    } as never);

    const assets = await loader.listAssets('project-1');
    assert.equal(assets.length, 9);
    assert.equal(assets[0].targetType, 'project_outline');
    assert.equal(assets.find((asset) => asset.targetType === 'chapter_draft' && asset.draftId === 'draft-1')?.draftVersion, 2);
    assert.equal(assets.find((asset) => asset.targetType === 'volume_outline' && asset.targetId === 'volume-2')?.isScoreable, false);
    assert.equal(assets.find((asset) => asset.targetType === 'chapter_craft_brief' && asset.targetId === 'chapter-2')?.isScoreable, false);
    assert.match(assets.find((asset) => asset.targetType === 'chapter_draft' && asset.draftId === 'draft-2')?.unavailableReason ?? '', /draft content/);
  }

  {
    const loader = new ScoringTargetLoaderService({
      project: { findUnique: async () => null },
      volume: { findMany: async () => [] },
      chapter: { findMany: async () => [] },
      chapterDraft: { findMany: async () => [] },
    } as never);
    await assert.rejects(() => loader.listAssets('missing-project'), NotFoundException);
  }

  {
    const prisma = {
      project: { findUnique: async () => ({ id: 'project-1' }) },
      scoringRun: {
        findMany: async () => [
          {
            id: 'score-1',
            targetType: 'chapter_draft',
            targetId: 'chapter-1',
            draftId: 'draft-1',
            platformProfile: 'generic_longform',
            overallScore: 82,
            verdict: 'pass',
            createdAt: new Date('2026-05-16T00:00:00.000Z'),
          },
        ],
      },
    };
    const targetLoader = {
      listAssets: async () => [
        { targetType: 'chapter_draft', targetId: 'chapter-1', draftId: 'draft-1', draftVersion: 2, title: 'Draft', source: 'generation' },
        { targetType: 'chapter_outline', targetId: 'chapter-1', title: 'Outline', source: 'Chapter.outline' },
      ],
    };
    const service = new ScoringService(prisma as never, targetLoader as never, {} as never);
    const assets = await service.listAssets('project-1');
    assert.equal(assets[0].hasScoringReports, true);
    assert.equal(assets[0].latestRun?.id, 'score-1');
    assert.equal(assets[1].hasScoringReports, false);
  }

  {
    const service = {
      listAssets: async (projectId: string) => [{ targetType: 'project_outline', targetId: projectId, title: 'Project', source: 'Project.outline' }],
    };
    const controller = new ScoringController(service as never);
    const assets = await controller.listAssets('project-1');
    assert.equal(assets[0].targetId, 'project-1');
  }

  {
    const prisma = { project: { findUnique: async () => null } };
    const service = new ScoringService(prisma as never, { listAssets: async () => [] } as never, {} as never);
    await assert.rejects(() => service.listAssets('missing-project'), NotFoundException);
  }
}

run().then(() => {
  console.log('scoring assets: ok');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
