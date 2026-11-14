import { computeInvalidProgress } from '@tarkovtracker/progress-contracts/progressInvalidation';
import { getTaskCatalogInvalidator } from './task-catalog';
import type {
  UserProgressData,
  UserProgressModeRow,
  TarkovTask,
  TarkovHideoutStation,
  ProgressResponseData,
  ProgressResponseTask,
  ProgressResponseObjective,
  ProgressResponseHideoutModule,
  ProgressResponseHideoutPart,
  ProgressResponseTrader,
  TraderProgress,
} from '../types';
const STASH_STATION_ID = '5d484fc0654e76006657e0ab';
const CULTIST_CIRCLE_STATION_ID = '667298e75ea6b4493c08f266';
/**
 * Extract game mode specific data from user progress row
 */
export function extractGameModeData(row: UserProgressModeRow | null): UserProgressData | null {
  if (!row) return null;
  return row.progress_data ?? null;
}
/**
 * Apply hideout auto-complete based on game edition
 */
function applyHideoutAutoComplete(
  hideoutModules: ProgressResponseHideoutModule[],
  hideoutParts: ProgressResponseHideoutPart[],
  hideoutStations: TarkovHideoutStation[],
  gameEdition: number
): void {
  const stashStation = hideoutStations.find((s) => s.id === STASH_STATION_ID);
  stashStation?.levels?.forEach((level) => {
    if (level.level <= gameEdition) {
      markModuleComplete(hideoutModules, level.id);
      level.itemRequirements?.forEach((item) => {
        markPartComplete(hideoutParts, item.id, item.count);
      });
    }
  });
  // Unheard Edition (5 or 6) gets Cultist Circle
  if (gameEdition >= 5) {
    const cultistCircle = hideoutStations.find((s) => s.id === CULTIST_CIRCLE_STATION_ID);
    cultistCircle?.levels?.forEach((level) => {
      markModuleComplete(hideoutModules, level.id);
      level.itemRequirements?.forEach((item) => {
        markPartComplete(hideoutParts, item.id, item.count);
      });
    });
  }
}
function markModuleComplete(modules: ProgressResponseHideoutModule[], id: string): void {
  const existing = modules.find((m) => m.id === id);
  if (existing) {
    existing.complete = true;
  } else {
    modules.push({ id, complete: true });
  }
}
function markPartComplete(parts: ProgressResponseHideoutPart[], id: string, count: number): void {
  const existing = parts.find((p) => p.id === id);
  if (existing) {
    existing.complete = true;
    existing.count = count;
  } else {
    parts.push({ id, complete: true, count });
  }
}
// Same defaults as the app's getTraderLevel/getTraderReputation for absent or unusable values.
const DEFAULT_TRADER_LEVEL = 1;
const DEFAULT_TRADER_REPUTATION = 0;
function traderLevel(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 1
    ? (value as number)
    : DEFAULT_TRADER_LEVEL;
}
function traderReputation(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_TRADER_REPUTATION;
}
/**
 * Stored trader standing, one entry per trader the user has saved. Traders without an entry
 * use the app defaults (level 1, reputation 0).
 */
function transformTraders(traders: unknown): ProgressResponseTrader[] {
  if (!traders || typeof traders !== 'object' || Array.isArray(traders)) return [];
  return Object.entries(traders as Record<string, unknown>).flatMap(([id, data]) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
    const { level, reputation } = data as TraderProgress;
    return [{ id, level: traderLevel(level), reputation: traderReputation(reputation) }];
  });
}
/**
 * Transform user progress to API response format
 */
export function transformProgress(
  progressData: UserProgressData | null,
  userId: string,
  gameEdition: number,
  tasks: TarkovTask[],
  hideoutStations: TarkovHideoutStation[],
  fallbackDisplayName?: string | null
): ProgressResponseData {
  const pmcFaction = progressData?.pmcFaction ?? 'USEC';
  const taskCompletions = progressData?.taskCompletions ?? {};
  // Compute invalid tasks/objectives
  const invalidator = getTaskCatalogInvalidator(tasks) ?? computeInvalidProgress;
  const { invalidTasks, invalidObjectives } = invalidator({
    tasks,
    taskCompletions,
    pmcFaction,
  });
  // Transform tasks to array format
  const tasksProgress: ProgressResponseTask[] = Object.entries(taskCompletions).map(
    ([id, data]) => {
      const entry: ProgressResponseTask = {
        id,
        complete: data.complete === true && data.failed !== true,
      };
      if (invalidTasks[id]) {
        entry.invalid = true;
      }
      if (data.failed === true) {
        entry.failed = true;
      }
      return entry;
    }
  );
  // Transform objectives to array format
  const taskObjectivesProgress: ProgressResponseObjective[] = Object.entries(
    progressData?.taskObjectives ?? {}
  ).map(([id, data]) => {
    const entry: ProgressResponseObjective = {
      id,
      complete: data.complete === true,
    };
    if (typeof data.count === 'number' && data.count > 0) {
      entry.count = data.count;
    }
    if (invalidObjectives[id]) {
      entry.invalid = true;
    }
    return entry;
  });
  // Transform hideout modules
  const hideoutModulesProgress: ProgressResponseHideoutModule[] = Object.entries(
    progressData?.hideoutModules ?? {}
  ).map(([id, data]) => ({
    id,
    complete: data.complete === true,
  }));
  // Transform hideout parts
  const hideoutPartsProgress: ProgressResponseHideoutPart[] = Object.entries(
    progressData?.hideoutParts ?? {}
  ).map(([id, data]) => {
    const entry: ProgressResponseHideoutPart = {
      id,
      complete: data.complete === true,
    };
    if (typeof data.count === 'number' && data.count > 0) {
      entry.count = data.count;
    }
    return entry;
  });
  // Apply hideout auto-complete based on game edition
  applyHideoutAutoComplete(
    hideoutModulesProgress,
    hideoutPartsProgress,
    hideoutStations,
    gameEdition
  );
  const displayName =
    (typeof progressData?.displayName === 'string' && progressData.displayName.trim()
      ? progressData.displayName.trim()
      : null) ||
    fallbackDisplayName ||
    userId.substring(0, 6);
  return {
    tasksProgress,
    taskObjectivesProgress,
    hideoutModulesProgress,
    hideoutPartsProgress,
    tradersProgress: transformTraders(progressData?.traders),
    displayName,
    userId,
    playerLevel: progressData?.level ?? 1,
    gameEdition,
    pmcFaction,
  };
}
