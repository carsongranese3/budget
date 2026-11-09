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
  fixed: boolean;
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
  note: string | null; custom_description: string | null; receipt_count: number;
  original_date: string | null;
  /** Split parts only: the hidden split parent's id. */
  parent_id: number | null;
  /** Split parts only: the parent's full signed amount. */
  split_total_cents: number | null;
}
export interface Receipt {
  id: number; transaction_id: number; file_name: string; mime_type: string; size_bytes: number; created_at: string;
}
export interface UploadReceiptRequest { file_name: string; content_base64: string }
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
export interface UpdateCategoryRequest { name?: string; color?: string; excluded_from_totals?: boolean; fixed?: boolean }

// Rules
export interface RuleImpactResponse { uncategorized_count: number }
export interface CreateRuleRequest { merchant: string; category_id: number }
export interface CreateRuleResponse { rule: Rule; applied_count: number }
export interface ApplyRulesResponse { applied_count: number }
export interface UpdateRuleRequest { merchant?: string; category_id?: number }

// Transactions
/** month is required unless all = 1. day must be a real date and inside month when both are given. */
export interface TransactionsQuery { month?: string; all?: 1; q?: string; account?: number; category?: number; day?: string }
export interface TransactionsResponse { transactions: Transaction[]; income_cents: number; spent_cents: number }
export interface UpdateTransactionRequest { category_id?: number; note?: string | null; custom_description?: string | null; date?: string }
export interface UncategorizedCountResponse { count: number }
export interface BulkCategoryRequest { ids: number[]; category_id: number }
export interface BulkCategoryResponse { updated_count: number; transactions: Transaction[] }

// Splits
export interface SplitPartInput { amount_cents: number; category_id: number; note?: string | null }
export interface SplitRequest { parts: SplitPartInput[] }
export type SplitResponse = Transaction[];
export interface SplitGroup { parent: Transaction; parts: Transaction[] }

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
  /** Eligible `fixed` categories only: their non-null budgets / their spending (budgeted or not). Included in the totals above. */
  fixed_budget_cents: number; fixed_spent_cents: number;
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

export interface RecurringSuggestion {
  merchant: string; name: string; amount_cents: number; frequency: Frequency;
  category_id: number; account_id: number | null;
  last_date: string; next_date: string; occurrences: number;
}

// Trends (GET /api/trends?end=YYYY-MM): arrays are 12 long, aligned to `months`.
export interface TrendsResponse {
  months: string[];
  income_cents: number[];
  spent_cents: number[];
  categories: { category_id: number; spent_cents: number[] }[];
  ytd: { year: number; income_cents: number; spent_cents: number; categories: { category_id: number; spent_cents: number }[] };
}
