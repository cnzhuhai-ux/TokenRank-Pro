-- credits（积分）计费工具（Qoder 等）：day 级聚合 JSON {total, tools:[[tool,amount]]}
ALTER TABLE daily_totals ADD COLUMN credits_json TEXT;
