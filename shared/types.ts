// API request/response types. Must match docs/api.md exactly.

export type AccountType = "checking" | "credit_card" | "savings";
export type ColumnRole = "date" | "description" | "amount" | "debit" | "credit" | "ignore";
export type SignMode = "purchases_negative" | "purchases_positive" | "debit_credit";
export type Frequency = "monthly" | "biweekly" | "yearly";
export type SystemKey = "income" | "transfer" | "uncategorized";

// Errors
export type ErrorCode =
  | "validation" | "invalid_file" | "nothing_to_import" | "forbidden"
  | "not_found" | "conflict" | "payload_too_large" | "unsupported_media_type" | "internal";
export interface ApiError { error: { code: ErrorCode; message: string } }

// Entities
export interface CsvFormat {
  header_signature: string;
  column_roles: ColumnRole[];
  sign_mode: SignMode;
  date_format: "MDY" | "YMD";
  has_header: boolean;
}
export interface Account {
  id: number; name: string; type: AccountType;
  csv_format: CsvFormat | null;
  last_import_date: string | null;
  created_at: string;
}
export interface Category {
  id: number; name: string; color: string;
  excluded_from_totals: boolean;
  system_key: SystemKey | null;
  sort_order: number;
}
export interface CategoryWithCounts extends Category {
  transaction_count: number; recurring_count: number; rule_count: number;
}
export interface Rule { id: number; merchant: string; category_id: number; created_at: string }
export interface Transaction {
  id: number; account_id: number; date: string; description: string;
  amount_cents: number; category_id: number; import_id: number; created_at: string;
}
export interface ImportRecord {
  id: number; file_name: string; account_id: number; imported_at: string;
  row_count: number; new_count: number; skipped_count: number; unreadable_count: number;
  first_date: string | null; last_date: string | null;
}
export interface RecurringItem {
  id: number; name: string; amount_cents: number;
  category_id: number; account_id: number | null;
  frequency: Frequency; anchor_date: string; match_text: string; active: boolean;
}
export interface Occurrence {
  recurring_id: number; name: string; amount_cents: number;
  category_id: number; account_id: number | null; date: string;
}

// GET /api/months
export interface MonthsResponse {
  today: string; current_month: string; earliest_month: string; latest_month: string;
  has_transactions: boolean;
}

// Accounts
export interface UpdateAccountRequest { name?: string; type?: AccountType; csv_format?: null }

// Categories
export interface CreateCategoryRequest { name: string }
export interface ReorderCategoriesRequest { ids: number[] }
export interface UpdateCategoryRequest { name?: string; color?: string; excluded_from_totals?: boolean }

// Rules
export interface RuleImpactResponse { uncategorized_count: number }
export interface CreateRuleRequest { merchant: string; category_id: number }
export interface CreateRuleResponse { rule: Rule; applied_count: number }
export interface ApplyRulesResponse { applied_count: number }
export interface UpdateRuleRequest { merchant?: string; category_id?: number }

// Transactions
export interface TransactionsQuery { month: string; q?: string; account?: number; category?: number }
export interface TransactionsResponse { transactions: Transaction[]; income_cents: number; spent_cents: number }
export interface UpdateTransactionRequest { category_id: number }
export interface UncategorizedCountResponse { count: number }

// Import
export interface SampleCsvResponse { file_name: string; content: string }
export interface PreviewRequest {
  file_name: string; content: string;
  account_id?: number | null; format?: CsvFormat;
}
export interface PreviewRow {
  line: number; date: string; description: string; amount_cents: number;
  category_id: number; rule_merchant: string | null;
}
export interface UnreadableRow { line: number; raw: string }
export interface PreviewReview {
  account_id: number | null; format: CsvFormat;
  new_rows: PreviewRow[]; duplicate_rows: PreviewRow[]; unreadable_rows: UnreadableRow[];
}
export interface PreviewResponse {
  file_name: string; row_count: number;
  columns: string[]; sample_rows: string[][];
  detected_format: CsvFormat;
  matched_accounts: { id: number; name: string }[];
  suggested_account_id: number | null;
  review: PreviewReview | null;
}
export interface CommitImportRequest {
  file_name: string; content: string;
  account_id: number | null;
  new_account: { name: string; type: AccountType } | null;
  format: CsvFormat;
  save_format: boolean;
  category_overrides: { line: number; category_id: number }[];
}
export interface MatchedRecurring { recurring_id: number; name: string; date: string }
export interface CommitImportResponse {
  import: ImportRecord; account: Account;
  uncategorized_count: number; matched_recurring: MatchedRecurring[];
}
export interface ImportListItem extends ImportRecord { account_name: string; transaction_count: number }
export interface UndoImportResponse { removed_count: number }

// Summary (slice 2)
export interface SummaryResponse {
  month: string;
  income_cents: number; spent_cents: number; net_cents: number;
  income_count: number; spent_count: number; uncategorized_count: number;
  expected_income_cents: number; expected_spent_cents: number;
  by_category: { category_id: number; spent_cents: number }[];
  series: { month: string; income_cents: number; spent_cents: number }[];
}

// Budgets (slice 2)
export interface BudgetsResponse {
  month: string;
  items: { category_id: number; budget_cents: number | null; spent_cents: number }[];
  /** Unbudgeted spend bucket: spent = items with no budget; budget_cents null when unset. */
  other: { budget_cents: number | null; spent_cents: number };
  total_budget_cents: number; spent_cents: number;
}
/** category_id null = the Other budget. */
export interface SetBudgetRequest { month: string; category_id: number | null; amount_cents: number }
export interface CopyBudgetsRequest { month: string }
export interface CopyBudgetsResponse { copied_count: number; budgets: BudgetsResponse }

// Recurring (slice 3)
export interface RecurringStatus { kind: "paused" | "none" | "received" | "expected"; date: string | null }
export interface RecurringListItem extends RecurringItem { next_date: string; status: RecurringStatus }
export type CreateRecurringRequest = Omit<RecurringItem, "id" | "active"> & { active?: boolean };
export type UpdateRecurringRequest = Partial<CreateRecurringRequest>;
export interface UpcomingResponse { expected: Occurrence[]; upcoming: Occurrence[] }
