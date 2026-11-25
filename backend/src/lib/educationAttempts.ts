import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { registerDatabase } from "./databaseLifecycle.js";

export interface QuizAttempt {
  userId: string;
  quizId: string;
  attemptNumber: number;
  score: number;
  answers: number[];
  submittedAt: string;
}

interface QuizProgressRow {
  quizId: string;
  score: number;
}

let database: Database.Database | undefined;
let databasePathOverride: string | undefined;

function getDatabase(): Database.Database {
  if (database) return database;
  const databasePath = databasePathOverride ?? process.env.EDUCATION_DB_PATH ?? resolve(process.cwd(), "data", "education.db");
  if (databasePath !== ":memory:") mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS education_quiz_attempts (
      user_id TEXT NOT NULL,
      quiz_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      score REAL NOT NULL,
      answers_json TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      PRIMARY KEY (user_id, quiz_id, attempt_number)
    );
  `);
  registerDatabase("education-attempts", () => {
    database?.close();
    database = undefined;
  });
  return database;
}

/** Insert a quiz attempt or replace the prior result for the same retry key. */
export function upsertQuizAttempt(attempt: QuizAttempt): QuizAttempt {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO education_quiz_attempts
      (user_id, quiz_id, attempt_number, score, answers_json, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, quiz_id, attempt_number) DO UPDATE SET
      score = excluded.score,
      answers_json = excluded.answers_json,
      submitted_at = excluded.submitted_at
  `).run(
    attempt.userId,
    attempt.quizId,
    attempt.attemptNumber,
    attempt.score,
    JSON.stringify(attempt.answers),
    attempt.submittedAt,
  );
  return getQuizAttempt(attempt.userId, attempt.quizId, attempt.attemptNumber)!;
}

export function getQuizAttempt(userId: string, quizId: string, attemptNumber: number): QuizAttempt | undefined {
  const row = getDatabase().prepare(`
    SELECT user_id AS userId, quiz_id AS quizId, attempt_number AS attemptNumber,
      score, answers_json AS answersJson, submitted_at AS submittedAt
    FROM education_quiz_attempts
    WHERE user_id = ? AND quiz_id = ? AND attempt_number = ?
  `).get(userId, quizId, attemptNumber) as
    | (Omit<QuizAttempt, "answers"> & { answersJson: string })
    | undefined;
  if (!row) return undefined;
  const { answersJson, ...attempt } = row;
  return { ...attempt, answers: JSON.parse(answersJson) as number[] };
}

/** Return each user's best score per quiz, preserving the progress API shape. */
export function getQuizProgress(userId: string): Record<string, number> {
  const rows = getDatabase().prepare(`
    SELECT quiz_id AS quizId, MAX(score) AS score
    FROM education_quiz_attempts
    WHERE user_id = ?
    GROUP BY quiz_id
  `).all(userId) as QuizProgressRow[];
  return Object.fromEntries(rows.map(({ quizId, score }) => [quizId, score]));
}

export function getNextQuizAttemptNumbers(userId: string): Record<string, number> {
  const rows = getDatabase().prepare(`
    SELECT quiz_id AS quizId, MAX(attempt_number) + 1 AS nextAttemptNumber
    FROM education_quiz_attempts
    WHERE user_id = ?
    GROUP BY quiz_id
  `).all(userId) as Array<{ quizId: string; nextAttemptNumber: number }>;
  return Object.fromEntries(rows.map(({ quizId, nextAttemptNumber }) => [quizId, nextAttemptNumber]));
}

/** Configure an isolated database location in tests before exercising the store. */
export function setEducationAttemptsDatabasePathForTests(databasePath: string): void {
  database?.close();
  database = undefined;
  databasePathOverride = databasePath;
}

export function resetEducationAttemptsStoreForTests(): void {
  database?.close();
  database = undefined;
  databasePathOverride = undefined;
}
