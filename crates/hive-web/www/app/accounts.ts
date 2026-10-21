// The people whose computers this browser is paired with, each an account: the computers it paired
// with, each under the key it paired with, and what that person is called. One account is shown at
// a time; the others stay paired. Kept in IndexedDB.

import { get, put, remove } from "./store.js";
import type { Paired } from "./types.js";

/** A computer this browser paired with, and the name of the key it paired with (store.ts). */
export interface Computer extends Paired {
  key: string;
}

export interface Account {
  /** The person, as the certificates name them. */
  person: string;
  /** What they are called, once one of their computers said. */
  name: string | null;
  computers: Computer[];
}

export interface Kept {
  accounts: Account[];
  active: string | null;
}

/** What is kept, from a browser paired before there were accounts too: its one computer becomes
 *  its person's account, under the key it paired with, and what it showed last is theirs. */
export async function load(): Promise<Kept> {
  const kept = await get<Kept>("accounts");
  if (kept) return kept;
  const paired = await get<Paired>("paired");
  if (!paired) return { accounts: [], active: null };
  const person = paired.certificate.person;
  const moved: Kept = { accounts: [{ person, name: null, computers: [{ ...paired, key: "device" }] }], active: person };
  const first = await get<unknown>("first");
  if (first) await put(`first:${person}`, first);
  await put("accounts", moved);
  await Promise.all(["paired", "home", "first"].map(remove));
  return moved;
}

export const save = (kept: Kept) => put("accounts", kept);

/** The account a computer `device` was paired under, and the computer. */
export function pairedWith(kept: Kept, device: string): { account: Account; computer: Computer } | null {
  for (const account of kept.accounts) {
    const computer = account.computers.find((c) => c.with.device === device);
    if (computer) return { account, computer };
  }
  return null;
}

/** `paired`, given by pairing under `key`, kept: in its person's account, made when there is none,
 *  in place of the same computer paired before. That account is shown. */
export function keep(kept: Kept, paired: Paired, key: string): Account {
  const person = paired.certificate.person;
  let account = kept.accounts.find((a) => a.person === person);
  if (!account) {
    account = { person, name: null, computers: [] };
    kept.accounts.push(account);
  }
  account.computers = [...account.computers.filter((c) => c.with.device !== paired.with.device), { ...paired, key }];
  kept.active = person;
  return account;
}

/** Forget `person`'s account; another is shown, when there is one. The keys only it used. */
export function forgetAccount(kept: Kept, person: string): string[] {
  const gone = kept.accounts.find((a) => a.person === person);
  kept.accounts = kept.accounts.filter((a) => a.person !== person);
  if (kept.active === person) kept.active = kept.accounts[0]?.person ?? null;
  const still = new Set(kept.accounts.flatMap((a) => a.computers.map((c) => c.key)));
  return [...new Set(gone?.computers.map((c) => c.key) ?? [])].filter((k) => !still.has(k));
}

/** What an account is called: the person's name, else the first computer's. */
export function accountName(a: Account): string {
  return a.name ?? a.computers[0]?.with.name ?? "your computer";
}
