# Odoo reference (read this before writing any Odoo code)

Our Odoo is **version 20** (the server reports `odoo/20.0`). The documentation links below are the 19.0 pages, which are the closest official ones.

| What | Link |
|---|---|
| How to call Odoo from outside (JSON-2: URL, API key, database header, transactions, migrating from XML-RPC) | https://www.odoo.com/documentation/19.0/developer/reference/external_api.html |
| What can be called: the ORM methods (`search_read`, `read`, `create`, `write`, `unlink`, domains, fields) | https://www.odoo.com/documentation/19.0/developer/reference/backend/orm.html |
| The source code (models, fields and methods exactly as they are) | https://github.com/odoo/odoo/tree/19.0 |

How they fit together: the ORM page says which methods exist and what they do; the external API page says how to reach them over HTTP. Every public ORM method of a model can be called as `POST /json/2/<model>/<method>`.

## Facts proven on our live Odoo (do not guess these again)
- Call: `POST {ODOO_URL}/json/2/{model}/{method}`, header `Authorization: bearer <API key>`, optional `X-Odoo-Database`, JSON body with `ids`, `context` and the method's own arguments (`domain`, `fields`, `vals_list` for create, `vals` for write).
- Each call is its own transaction.
- A file field (for example `invoice_pdf_report_file`, attachment `datas`) comes back as an object `{filename, content (base64), size}`, not as text.
- `res.partner` has `is_company`, not `company_type`; Saudi fields are `l10n_sa_edi_building_number` and `l10n_sa_edi_plot_identification`.
- The company's standard sales VAT is `res.company.account_sale_tax_id`; Odoo does not fill a product's VAT on invoice lines created through the API, so set `tax_ids` on each line.
- Invoice ZATCA state is `account.move.l10n_sa_edi_state` (`to_send`, `accepted`, `warning`, `rejected`).
- Always check a field exists (`fields_get`) before using it; names differ between versions.
