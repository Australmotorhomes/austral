/* eslint-disable no-unused-vars, react-hooks/exhaustive-deps */
import React, { useState, useEffect, useCallback, useRef } from "react";
import html2pdf from "html2pdf.js";

/* ============================================================
   Austral Motorhomes & Platinum Pontoons — Supplier Pricing, Quotes & Purchase Orders
   Data persists to Supabase via REST API with polling for updates.
   ============================================================ */

// Supabase REST API Configuration (from environment variables)
const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || "https://dpapwmittcowsrwwsajo.supabase.co";
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || "sb_publishable_0m-oMR8pDlxdij36m4Fj9w_yAVcVIVn";
const SUPABASE_HEADERS = {
  "Content-Type": "application/json",
  "apikey": SUPABASE_ANON_KEY,
  "Prefer": "return=representation",
};
// ---- Supabase Storage helpers ----
async function uploadAttachment(bucket, path, file) {
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": file.type },
    body: file,
  });
  if (!resp.ok) { const e = await resp.json(); throw new Error(e.message || "Upload failed"); }
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;
}

async function deleteAttachment(bucket, path) {
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;
  await fetch(url, { method: "DELETE", headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}` } });
}



// REST API helper for GET, POST, PATCH, DELETE
async function supabaseREST(method, table, data = null, filter = null) {
  try {
    let url = `${SUPABASE_URL}/rest/v1/${table}`;
    
    // Add select parameter for GET requests, or filter for GET/DELETE
    if (method === "GET" && !filter) {
      url += "?select=*";
    } else if ((method === "GET" || method === "DELETE") && filter) {
      url += `?${filter}`;
    }
    
    const options = {
      method,
      headers: SUPABASE_HEADERS,
    };
    
    if (data && (method === "POST" || method === "PATCH")) {
      options.body = JSON.stringify(data);
      console.log(`📤 ${method} ${table} request:`, { url, headers: SUPABASE_HEADERS, body: data });
    }
    
    const response = await fetch(url, options);
    console.log(`📥 ${method} ${table} response status:`, response.status);
    
    if (!response.ok) {
      const error = await response.json();
      console.error(`❌ ${method} ${table} error response:`, error);
      throw new Error(error.message || `HTTP ${response.status}`);
    }
    
    // DELETE with Prefer:return=representation returns 200+body; without it returns 204.
    // Either way we treat it as success and skip body parsing for DELETE.
    if (method === "DELETE") {
      console.log(`✅ DELETE ${table} success`);
      return { success: true };
    }

    // PATCH/POST with Prefer:return=representation returns 200+body
    if (response.status === 204) {
      console.log(`✅ ${method} ${table} success (204 No Content)`);
      return { success: true };
    }
    
    const result = await response.json();
    console.log(`✅ ${method} ${table} result:`, result);
    return result;
  } catch (err) {
    console.error(`Supabase REST error [${method} ${table}]:`, err);
    throw err;
  }
}

// Some tables (quotes, purchase_orders) don't have a documented camelCase→snake_case
// mapping the way items/customers/suppliers do, so the exact set of real columns isn't
// known client-side. Rather than guess field names, this wrapper POSTs/PATCHes and,
// if PostgREST reports a field as an unrecognised column, strips it and retries —
// so a save always succeeds using whatever columns actually exist, and never silently
// drops a column that IS valid.
async function supabaseRESTWithSchemaFallback(method, table, data, filter = null) {
  const payload = { ...data };
  const droppedFields = [];
  // NEVER retry POST requests — each retry creates a duplicate record.
  // For POST, fail fast so the caller can fix toSupabaseFormat instead.
  if (method === "POST") {
    return supabaseREST(method, table, payload, filter);
  }
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const result = await supabaseREST(method, table, payload, filter);
      if (droppedFields.length) {
        console.warn(
          `⚠️ ${method} ${table} succeeded after dropping fields not present in the Supabase schema:`,
          droppedFields
        );
      }
      return result;
    } catch (err) {
      const match = /Could not find the '([^']+)' column/.exec(err.message || "");
      if (match && Object.prototype.hasOwnProperty.call(payload, match[1])) {
        droppedFields.push(match[1]);
        delete payload[match[1]];
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${method} ${table} failed after removing unknown columns: ${droppedFields.join(", ")}`);
}


const DEFAULT_MODELS = ["Campo", "Scout", "Savanna"];
const DEFAULT_CATEGORIES = [
  "Chassis & Structure",
  "Electrical",
  "Plumbing & Gas",
  "Cabinetry & Fitout",
  "Exterior & Canopy",
  "Options & Upgrades",
  "Other",
];
const DATA_KEY = "austral:db";

const FALLBACK_USD_AUD_RATE = 1.41; // seeded planning estimate, see rate panel for live/manual value in use
const DEFAULT_MARGIN = 0.5; // cost is 50% of sell price → sell = cost / (1 - margin) = cost * 2

// ---- Date Formatting ----
function parseDateInput(ddmmyy) {
  if (!ddmmyy) return null;
  try {
    const [dd, mm, yy] = ddmmyy.split("-");
    const yyyy = yy.length === 2 ? (parseInt(yy) > 50 ? "19" + yy : "20" + yy) : yy;
    return `${yyyy}-${mm}-${dd}`;
  } catch {
    return ddmmyy;
  }
}

// Safely parse an activities value from Supabase. The column is JSONB, so
// PostgREST normally returns a JS array — but if the column type is text or
// the value was stored as a JSON string, it comes back as a string and
// Array.isArray returns false, silently resetting activities to [].
function parseActivities(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return [];
}

// ---- Data Transformation Helpers (camelCase <-> snake_case) ----
function toSupabaseFormat(data, table) {
  if (!data) return data;
  const copy = { ...data };
  
  switch (table) {
    case "suppliers":
      if (copy.address) {
        copy.address_street = copy.address.street || "";
        copy.address_suburb = copy.address.suburb || "";
        copy.address_state = copy.address.state || "QLD";
        copy.address_postcode = copy.address.postcode || "";
        delete copy.address;
      }
      if (copy.bankAccount) {
        copy.bank_account_name = copy.bankAccount.name || "";
        copy.bank_account_bsb = copy.bankAccount.bsb || "";
        copy.bank_account_number = copy.bankAccount.account || "";
        delete copy.bankAccount;
      }
      if (copy.contactPerson !== undefined) { copy.contact_person = copy.contactPerson; delete copy.contactPerson; }
      // Strip customer-only fields not present on suppliers table
      delete copy.invoices; delete copy.invoiceNumber; delete copy.invoiceAmount;
      delete copy.lastQuoteNumber; delete copy.lastQuoteValue;
      delete copy.attachments; delete copy.status; delete copy.product; delete copy.source;
      delete copy.createdAt; delete copy.updatedAt;
      break;

    case "customers":
      if (copy.address) {
        copy.address_street = copy.address.street || "";
        copy.address_suburb = copy.address.suburb || "";
        copy.address_state = copy.address.state || "QLD";
        copy.address_postcode = copy.address.postcode || "";
        delete copy.address;
      } else {
        copy.address_street = copy.address_street || "";
        copy.address_suburb = copy.address_suburb || "";
        copy.address_state = copy.address_state || "QLD";
        copy.address_postcode = copy.address_postcode || "";
      }
      if (copy.bankAccount) {
        copy.bank_account_name = copy.bankAccount.name || "";
        copy.bank_account_bsb = copy.bankAccount.bsb || "";
        copy.bank_account_number = copy.bankAccount.account || "";
        delete copy.bankAccount;
      }
      if (copy.contactPerson !== undefined) {
        copy.contact_person = copy.contactPerson;
        delete copy.contactPerson;
      }
      // Customer-specific fields
      if (copy.invoiceNumber !== undefined) {
        copy.invoice_number = copy.invoiceNumber;
        delete copy.invoiceNumber;
      }
      if (copy.invoices !== undefined) {
        // invoices is already JSONB-compatible array; normalise amounts to numbers
        copy.invoices = (copy.invoices || []).map(inv => ({
          amount: parseFloat(inv.amount) || 0,
          invoiceMonth: inv.invoiceMonth || "",
        })).filter(inv => inv.amount > 0 || inv.invoiceMonth);
        // keep copy.invoices as-is for Supabase JSONB column
      }
      if (copy.invoiceAmount !== undefined) {
        delete copy.invoiceAmount; // legacy field, no longer written
      }
      if (copy.lastQuoteNumber !== undefined) {
        copy.last_quote_number = copy.lastQuoteNumber;
        delete copy.lastQuoteNumber;
      }
      if (copy.lastQuoteValue !== undefined) {
        copy.last_quote_value = copy.lastQuoteValue;
        delete copy.lastQuoteValue;
      }
      if (copy.archived !== undefined) {
        copy.is_archived = copy.archived;
        delete copy.archived;
      }
      break;
      
    case "crm_prospects":
      if (copy.chanceOfClosing !== undefined) {
        copy.chance_of_closing = copy.chanceOfClosing;
        delete copy.chanceOfClosing;
      }
      if (copy.currentStatus !== undefined) {
        copy.current_status = copy.currentStatus;
        delete copy.currentStatus;
      }
      if (copy.firstContactDate !== undefined) {
        copy.first_contact_date = copy.firstContactDate;
        delete copy.firstContactDate;
      }
      if (copy.lastContactDate !== undefined) {
        copy.last_contact_date = copy.lastContactDate;
        delete copy.lastContactDate;
      }
      if (copy.expectedOrderEtaMonth !== undefined) {
        copy.expected_order_eta_month = copy.expectedOrderEtaMonth;
        delete copy.expectedOrderEtaMonth;
      }
      if (copy.enquiryProduct !== undefined) {
        copy.enquiry_product = copy.enquiryProduct;
        delete copy.enquiryProduct;
      }
      if (copy.salesValue !== undefined) {
        copy.value = copy.salesValue;  // ← salesValue → value
        delete copy.salesValue;
      }
      // Remove non-existent columns
      delete copy.createdAt;
      delete copy.updatedAt;
      // activities is a JSONB column — keep it so it gets written
      break;
      
    case "items":
      // Supabase items table columns: id, number, description, model, category, supplier, cost_aud, created_at, updated_at
      // The app's "name" field has no matching column — store it in description.
      if (copy.name !== undefined) {
        copy.description = copy.name;
        delete copy.name;
      }
      if (copy.cost !== undefined) {
        copy.cost_aud = copy.cost;
        delete copy.cost;
      }
      // sell_price column now exists; write it. currency has no column.
      if (copy.sellPrice !== undefined) {
        copy.sell_price = copy.sellPrice;
        delete copy.sellPrice;
      }
      delete copy.currency;
      // notes column now exists — keep it as-is
      if (copy.itemDescription !== undefined) {
        copy.long_description = copy.itemDescription;
        delete copy.itemDescription;
      }
      delete copy.createdAt;
      delete copy.updatedAt;
      if (!copy.number) copy.number = `ITEM-${Date.now()}`;
      break;

    case "quotes":
    case "purchase_orders":
      // Confirmed live Supabase columns (via information_schema.columns):
      // quotes: id, number, party, customer, model, date, contact, status, discount, total,
      //         notes, created_at, updated_at, lines, subtotal, gst, gross_profit_pct, fx_rate_used
      // purchase_orders: same, minus none — model/discount/payment_milestones added via migration
      // so both tables now share the same shape.
      if (copy.createdAt !== undefined) {
        copy.created_at = copy.createdAt;
        delete copy.createdAt;
      }
      if (copy.updatedAt !== undefined) {
        copy.updated_at = copy.updatedAt;
        delete copy.updatedAt;
      }
      if (copy.customsClearance !== undefined) {
        copy.customs_clearance = copy.customsClearance;
        delete copy.customsClearance;
      }
      if (copy.paymentMilestones !== undefined) {
        copy.payment_milestones = copy.paymentMilestones;
        delete copy.paymentMilestones;
      }
      if (copy.grossProfitPct !== undefined) {
        copy.gross_profit_pct = copy.grossProfitPct;
        delete copy.grossProfitPct;
      }
      if (copy.fxRateUsed !== undefined) {
        copy.fx_rate_used = copy.fxRateUsed;
        delete copy.fxRateUsed;
      }
      if (copy.consolidatedGroupId !== undefined) {
        copy.consolidated_group_id = copy.consolidatedGroupId || null;
        delete copy.consolidatedGroupId;
      }
      if (copy.consolidatedMemberIds !== undefined) {
        copy.consolidated_member_ids = copy.consolidatedMemberIds;
        delete copy.consolidatedMemberIds;
      }
      if (copy.customerId !== undefined) {
        copy.customer_id = copy.customerId;
        delete copy.customerId;
      }
      if (copy.supplierId !== undefined) {
        copy.supplier_id = copy.supplierId;
        delete copy.supplierId;
      }
      if (copy.quoteId !== undefined) {
        copy.quote_id = copy.quoteId;
        delete copy.quoteId;
      }
      if (copy.supplierNote !== undefined) {
        copy.supplier_note = copy.supplierNote;
        delete copy.supplierNote;
      }
      if (copy.quoteNumber !== undefined) {
        copy.quote_number = copy.quoteNumber;
        delete copy.quoteNumber;
      }
      if (copy.consolidatedGroupId !== undefined) {
        copy.consolidated_group_id = copy.consolidatedGroupId || null;
        delete copy.consolidatedGroupId;
      }
      if (copy.consolidatedMemberIds !== undefined) {
        copy.consolidated_member_ids = copy.consolidatedMemberIds;
        delete copy.consolidatedMemberIds;
      }
      // Strip camelCase timestamps — columns are created_at/updated_at (server defaults)
      delete copy.createdAt;
      delete copy.updatedAt;
      break;
  }
  return copy;
}

function fromSupabaseFormat(data, table) {
  if (!data) return data;
  const copy = { ...data };
  
  switch (table) {
    case "suppliers":
    case "customers":
      if (copy.address_street) {
        copy.address = { street: copy.address_street || "", suburb: copy.address_suburb || "", state: copy.address_state || "QLD", postcode: copy.address_postcode || "" };
      }
      if (copy.bank_account_name) {
        copy.bankAccount = { name: copy.bank_account_name || "", bsb: copy.bank_account_bsb || "", account: copy.bank_account_number || "" };
      }
      if (copy.contact_person) copy.contactPerson = copy.contact_person;
      // Customer-specific fields
      if (copy.invoice_number !== undefined) copy.invoiceNumber = copy.invoice_number;
      if (copy.invoices !== undefined) copy.invoices = copy.invoices || [];
      if (copy.invoice_amount !== undefined) copy.invoiceAmount = copy.invoice_amount;
      if (copy.last_quote_number !== undefined) copy.lastQuoteNumber = copy.last_quote_number;
      if (copy.last_quote_value !== undefined) copy.lastQuoteValue = copy.last_quote_value;
      if (copy.is_archived !== undefined) copy.archived = copy.is_archived;
      copy.attachments = Array.isArray(copy.attachments) ? copy.attachments : [];
      copy.activities = parseActivities(copy.activities);
      break;
      
    case "crm_prospects":
      if (copy.chance_of_closing !== undefined) copy.chanceOfClosing = copy.chance_of_closing;
      if (copy.current_status !== undefined) copy.currentStatus = copy.current_status;
      if (copy.first_contact_date !== undefined) copy.firstContactDate = copy.first_contact_date;
      if (copy.last_contact_date !== undefined) copy.lastContactDate = copy.last_contact_date;
      if (copy.expected_order_eta_month !== undefined) copy.expectedOrderEtaMonth = copy.expected_order_eta_month;
      if (copy.enquiry_product !== undefined) copy.enquiryProduct = copy.enquiry_product;
      copy.salesValue = parseFloat(copy.sales_value || copy.value) || 0;
      copy.activities = parseActivities(copy.activities);
      copy.attachments = Array.isArray(copy.attachments) ? copy.attachments : [];
      break;
      
    case "items":
      if (copy.cost_aud !== undefined) copy.cost = copy.cost_aud;
      if (copy.description !== undefined) copy.name = copy.description;
      copy.currency = copy.currency || "AUD";
      copy.sellPrice = copy.sell_price != null ? parseFloat(copy.sell_price) : calcSellPrice(copy.cost);
      copy.notes = copy.notes || "";
      copy.itemDescription = copy.long_description || "";
      break;

    case "quotes":
    case "purchase_orders":
      if (copy.created_at !== undefined) { copy.createdAt = copy.created_at; delete copy.created_at; }
      if (copy.updated_at !== undefined) { copy.updatedAt = copy.updated_at; delete copy.updated_at; }
      if (copy.customs_clearance !== undefined) { copy.customsClearance = copy.customs_clearance; delete copy.customs_clearance; }
      if (copy.payment_milestones !== undefined) { copy.paymentMilestones = copy.payment_milestones; delete copy.payment_milestones; }
      if (copy.gross_profit_pct !== undefined) { copy.grossProfitPct = copy.gross_profit_pct; delete copy.gross_profit_pct; }
      if (copy.fx_rate_used !== undefined) { copy.fxRateUsed = copy.fx_rate_used; delete copy.fx_rate_used; }
      if (copy.customer_id !== undefined) { copy.customerId = copy.customer_id; delete copy.customer_id; }
      if (copy.supplier_id !== undefined) { copy.supplierId = copy.supplier_id; delete copy.supplier_id; }
      if (copy.quote_id !== undefined) { copy.quoteId = copy.quote_id; delete copy.quote_id; }
      if (copy.quote_number !== undefined) { copy.quoteNumber = copy.quote_number; delete copy.quote_number; }
      if (copy.supplier_note !== undefined) { copy.supplierNote = copy.supplier_note; delete copy.supplier_note; }
      copy.lines = Array.isArray(copy.lines) ? copy.lines : [];
      copy.paymentMilestones = Array.isArray(copy.paymentMilestones) ? copy.paymentMilestones : [];
      copy.attachments = Array.isArray(copy.attachments) ? copy.attachments : [];
      if (copy.consolidated_group_id !== undefined) { copy.consolidatedGroupId = copy.consolidated_group_id; delete copy.consolidated_group_id; }
      if (copy.consolidated_member_ids !== undefined) { 
        // Handle both array and JSON string from Supabase
        let parsed = copy.consolidated_member_ids;
        if (typeof parsed === 'string') {
          try { parsed = JSON.parse(parsed); } catch { parsed = []; }
        }
        copy.consolidatedMemberIds = Array.isArray(parsed) ? parsed : []; 
        delete copy.consolidated_member_ids; 
      }
      else { copy.consolidatedMemberIds = copy.consolidatedMemberIds || []; }
      break;
  }
  return copy;
}

// ---- REST API Helper Functions ----

async function getNextSequence(tableName) {
  try {
    // GET /sequences?table_name=eq.quote
    const data = await supabaseREST("GET", "sequences", null, `table_name=eq.${tableName}&select=*`);
    
    if (data && data.length > 0) {
      const nextValue = (data[0].next_value || 0) + 1;
      // PATCH /sequences?table_name=eq.quote
      await supabaseREST("PATCH", `sequences?table_name=eq.${tableName}`, { next_value: nextValue });
      return nextValue;
    } else {
      // POST /sequences
      await supabaseREST("POST", "sequences", { table_name: tableName, next_value: 1 });
      return 1;
    }
  } catch (err) {
    console.error('Sequence error:', err);
    return 1;
  }
}

async function loadAllData() {
  try {
    // Load all 10 tables using REST API GET
    const [items, quotes, pos, customers, suppliers, crm, categories] = await Promise.all([
      supabaseREST("GET", "items"),
      supabaseREST("GET", "quotes"),
      supabaseREST("GET", "purchase_orders"),
      supabaseREST("GET", "customers"),
      supabaseREST("GET", "suppliers"),
      supabaseREST("GET", "crm_prospects"),
      supabaseREST("GET", "categories"),
    ]);

    return {
      items: items || [],
      quotes: quotes || [],
      pos: pos || [],
      customers: customers || [],
      suppliers: suppliers || [],
      crm: crm || [],
      categories: categories || [],
    };
  } catch (err) {
    console.error('Load data error:', err);
    return null;
  }
}

// ---- Supabase REST API CRUD Operations ----

async function createRecord(table, data) {
  return await supabaseREST("POST", table, data);
}

async function updateRecord(table, id, data) {
  return await supabaseREST("PATCH", `${table}?id=eq.${id}`, data);
}

async function deleteRecord(table, id) {
  return await supabaseREST("DELETE", `${table}?id=eq.${id}`);
}

async function createQuote(quoteData) {
  try {
    const result = await createRecord("quotes", quoteData);
    return result[0];
  } catch (err) {
    console.error("Create quote error:", err);
    throw err;
  }
}

async function updateQuote(id, quoteData) {
  try {
    const result = await updateRecord("quotes", id, quoteData);
    return result[0];
  } catch (err) {
    console.error("Update quote error:", err);
    throw err;
  }
}

async function deleteQuote(id) {
  try {
    await deleteRecord("quotes", id);
  } catch (err) {
    console.error("Delete quote error:", err);
    throw err;
  }
}

async function createPurchaseOrder(poData) {
  try {
    const result = await createRecord("purchase_orders", poData);
    return result[0];
  } catch (err) {
    console.error("Create PO error:", err);
    throw err;
  }
}

async function updatePurchaseOrder(id, poData) {
  try {
    const result = await updateRecord("purchase_orders", id, poData);
    return result[0];
  } catch (err) {
    console.error("Update PO error:", err);
    throw err;
  }
}

async function deletePurchaseOrder(id) {
  try {
    await deleteRecord("purchase_orders", id);
  } catch (err) {
    console.error("Delete PO error:", err);
    throw err;
  }
}

async function createCustomer(customerData) {
  try {
    const result = await createRecord("customers", customerData);
    return result[0];
  } catch (err) {
    console.error("Create customer error:", err);
    throw err;
  }
}

async function updateCustomer(id, customerData) {
  try {
    const result = await updateRecord("customers", id, customerData);
    return result[0];
  } catch (err) {
    console.error("Update customer error:", err);
    throw err;
  }
}

async function deleteCustomer(id) {
  try {
    await deleteRecord("customers", id);
  } catch (err) {
    console.error("Delete customer error:", err);
    throw err;
  }
}

async function createSupplier(supplierData) {
  try {
    const result = await createRecord("suppliers", supplierData);
    return result[0];
  } catch (err) {
    console.error("Create supplier error:", err);
    throw err;
  }
}

async function updateSupplier(id, supplierData) {
  try {
    const result = await updateRecord("suppliers", id, supplierData);
    return result[0];
  } catch (err) {
    console.error("Update supplier error:", err);
    throw err;
  }
}

async function deleteSupplier(id) {
  try {
    await deleteRecord("suppliers", id);
  } catch (err) {
    console.error("Delete supplier error:", err);
    throw err;
  }
}

async function createCRMProspect(prospectData) {
  try {
    const result = await createRecord("crm_prospects", prospectData);
    return result[0];
  } catch (err) {
    console.error("Create CRM prospect error:", err);
    throw err;
  }
}

async function updateCRMProspect(id, prospectData) {
  try {
    const result = await updateRecord("crm_prospects", id, prospectData);
    return result[0];
  } catch (err) {
    console.error("Update CRM prospect error:", err);
    throw err;
  }
}

async function deleteCRMProspect(id) {
  try {
    await deleteRecord("crm_prospects", id);
  } catch (err) {
    console.error("Delete CRM prospect error:", err);
    throw err;
  }
}

function calcSellPrice(cost, margin = DEFAULT_MARGIN) {
  const n = Number(cost) || 0;
  const m = Number(margin);
  if (!m || m >= 1) return n * 2; // guard against bad input, fall back to the 50% default
  return n / (1 - m);
}

function uid(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}
function fmtMoney(n, currency = "AUD") {
  n = Number(n) || 0;
  const symbol = currency === "USD" ? "US$" : "$";
  return symbol + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-AU", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
// Convert a cost in its native currency to AUD using the current USD->AUD rate.
function toAUD(amount, currency, usdAudRate) {
  const n = Number(amount) || 0;
  if (currency === "USD") return n * (Number(usdAudRate) || FALLBACK_USD_AUD_RATE);
  return n;
}

// Parse CSV file content and return array of objects
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 1) return [];
  
  // Parse header
  const headers = parseCSVLine(lines[0]);
  
  // Parse data rows
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // Skip empty lines
    
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });
    rows.push(row);
  }
  
  return rows;
}

// Helper: parse a single CSV line handling quoted fields
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        // Toggle quote mode
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // End of field
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}

function emptyDB() {
  return {
    items: [
      { id: "item-001", name: "Campo Slide-On Camper", model: "Campo", category: "Chassis & Structure", currency: "AUD", cost: 8000, sellPrice: 16000, supplier: "Chassis Components Ltd", notes: "Complete Campo camper unit with all standard features", createdAt: "2026-06-01", updatedAt: "2026-06-01" },
      { id: "item-002", name: "Scout Slide-On Camper", model: "Scout", category: "Chassis & Structure", currency: "AUD", cost: 6000, sellPrice: 12000, supplier: "Chassis Components Ltd", notes: "Compact Scout camper, perfect for smaller vehicles", createdAt: "2026-06-01", updatedAt: "2026-06-01" },
      { id: "item-003", name: "Savanna Slide-On Camper", model: "Savanna", category: "Chassis & Structure", currency: "AUD", cost: 10000, sellPrice: 20000, supplier: "Chassis Components Ltd", notes: "Deluxe Savanna model with all premium features", createdAt: "2026-06-01", updatedAt: "2026-06-01" },
      { id: "item-004", name: "Solar Panel Kit 400W", model: "Campo", category: "Electrical", currency: "AUD", cost: 1500, sellPrice: 3000, supplier: "Electrical Supplies Australia", notes: "400W solar panel kit with controller and wiring", createdAt: "2026-06-01", updatedAt: "2026-06-01" },
      { id: "item-005", name: "Fresh Water Tank 80L", model: "Scout", category: "Plumbing & Gas", currency: "AUD", cost: 800, sellPrice: 1600, supplier: "Electrical Supplies Australia", notes: "Durable 80-litre fresh water storage tank", createdAt: "2026-06-01", updatedAt: "2026-06-01" }
    ],
    quotes: [
      { id: "q-001", number: 1, status: "Draft", party: "Sarah Johnson", model: "Scout", date: "2026-06-19", contact: "sarah.johnson@email.com", notes: "Prospect enquiry for Scout with solar upgrade", discount: 0, lines: [{ desc: "Scout Slide-On Camper", qty: 1, price: 12000, currency: "AUD", itemId: "item-002", cost: 6000 }, { desc: "Solar Panel Kit 400W", qty: 1, price: 3000, currency: "AUD", itemId: "item-004", cost: 1500 }], subtotal: 15000, gst: 0, total: 15000, grossProfitPct: 50, fxRateUsed: 1.41, createdAt: "2026-06-19", updatedAt: "2026-06-19" },
      { id: "q-002", number: 2, status: "Accepted", party: "John Smith", model: "Campo", date: "2026-06-18", contact: "john@smithconstruction.com.au", notes: "Quote accepted - Ready for PO generation", discount: 500, lines: [{ desc: "Campo Slide-On Camper", qty: 1, price: 16000, currency: "AUD", itemId: "item-001", cost: 8000 }, { desc: "Fresh Water Tank 80L", qty: 2, price: 1600, currency: "AUD", itemId: "item-005", cost: 800 }], subtotal: 18200, gst: 0, total: 17700, grossProfitPct: 50, fxRateUsed: 1.41, createdAt: "2026-06-18", updatedAt: "2026-06-19" },
      { id: "q-003", number: 3, status: "Sent", party: "Mike Davis Outdoor Adventures", model: "Savanna", date: "2026-06-17", contact: "mike@outdooradventures.com.au", notes: "Premium Savanna package with all upgrades", discount: 1000, lines: [{ desc: "Savanna Slide-On Camper", qty: 1, price: 20000, currency: "AUD", itemId: "item-003", cost: 10000 }, { desc: "Solar Panel Kit 400W", qty: 1, price: 3000, currency: "AUD", itemId: "item-004", cost: 1500 }], subtotal: 23000, gst: 0, total: 22000, grossProfitPct: 50, fxRateUsed: 1.41, createdAt: "2026-06-17", updatedAt: "2026-06-18" }
    ],
    pos: [],
    seq: { quote: 4, po: 1 },
    models: DEFAULT_MODELS.slice(),
    categories: DEFAULT_CATEGORIES.slice(),
    fx: { usdAudRate: FALLBACK_USD_AUD_RATE, source: "manual", updatedAt: "2026-06-19" },
    suppliers: [
      { id: "sup-001", name: "Chassis Components Ltd", contactPerson: "David Wilson", email: "orders@chassiscomponents.com.au", phone: "02 9876 5432", address: { street: "789 Industrial Drive", suburb: "Sydney", state: "NSW", postcode: "2000" }, bankAccount: { name: "Chassis Components Ltd", bsb: "032-456", account: "123456789" }, notes: "Primary chassis supplier. Competitive pricing, fast delivery.", createdAt: "2026-01-10", updatedAt: "2026-06-01" },
      { id: "sup-002", name: "Electrical Supplies Australia", contactPerson: "Jenny Chen", email: "sales@elec-supplies.com.au", phone: "07 3321 9876", address: { street: "321 Trade Park", suburb: "Gold Coast", state: "QLD", postcode: "4217" }, bankAccount: { name: "Electrical Supplies Australia", bsb: "064-123", account: "987654321" }, notes: "Quality solar and electrical components. Reliable partner.", createdAt: "2026-02-15", updatedAt: "2026-06-12" }
    ],
    customers: [
      { id: "cus-001", name: "Adventure Tours Co", email: "bookings@adventuretours.com.au", phone: "07 3456 7890", address: { street: "123 Outdoor Lane", suburb: "Brisbane", state: "QLD", postcode: "4000" }, product: "Savanna", notes: "Large tour operator, repeat customer potential. Previously purchased Savanna.", createdAt: "2026-05-01", updatedAt: "2026-06-10" },
      { id: "cus-002", name: "Remote Living Solutions", email: "sales@remoteliving.com.au", phone: "0412 123 456", address: { street: "456 Rural Road", suburb: "Toowoomba", state: "QLD", postcode: "4350" }, product: "Scout", notes: "Converted from prospect. Using Scout for mobile office setup. Very satisfied.", createdAt: "2026-04-15", updatedAt: "2026-06-19" }
    ],
    crm: [
      { id: "lead-001", name: "John Smith", email: "john@smithconstruction.com.au", phone: "0412 345 678", source: "Website", enquiryProduct: "Campo", chanceOfClosing: 70, currentStatus: "quote", firstContactDate: "2026-06-10", lastContactDate: "2026-06-18", expectedOrderEtaMonth: "2026-07", salesValue: 17700, notes: "Very interested, has accepted quote, ready to move forward", activities: [{ id: "act-001", date: "2026-06-10", type: "call", notes: "Initial inquiry about Campo model", createdAt: "2026-06-10" }, { id: "act-002", date: "2026-06-15", type: "email", notes: "Sent quote for Campo with water tanks", createdAt: "2026-06-15" }, { id: "act-003", date: "2026-06-18", type: "call", notes: "Quote accepted! Discussed delivery timeline", createdAt: "2026-06-18" }], createdAt: "2026-06-10", updatedAt: "2026-06-18" },
      { id: "lead-002", name: "Sarah Johnson", email: "sarah.johnson@email.com", phone: "0487 654 321", source: "Referral", enquiryProduct: "Scout", chanceOfClosing: 50, currentStatus: "quote", firstContactDate: "2026-06-12", lastContactDate: "2026-06-19", expectedOrderEtaMonth: "2026-08", salesValue: 15000, notes: "Interested in Scout with solar option. Comparing with competitors.", activities: [{ id: "act-004", date: "2026-06-12", type: "email", notes: "Inquiry received about Scout specs", createdAt: "2026-06-12" }, { id: "act-005", date: "2026-06-19", type: "email", notes: "Quote sent for Scout with solar kit upgrade", createdAt: "2026-06-19" }], createdAt: "2026-06-12", updatedAt: "2026-06-19" },
      { id: "lead-003", name: "Mike Davis Outdoor Adventures", email: "mike@outdooradventures.com.au", phone: "0456 789 123", source: "Trade Show", enquiryProduct: "Savanna", chanceOfClosing: 30, currentStatus: "call", firstContactDate: "2026-06-05", lastContactDate: "2026-06-17", expectedOrderEtaMonth: "2026-09", salesValue: 22000, notes: "Still evaluating options. Has budget but wants to review all features.", activities: [{ id: "act-006", date: "2026-06-05", type: "call", notes: "Met at trade show - interested in Savanna fleet", createdAt: "2026-06-05" }, { id: "act-007", date: "2026-06-17", type: "email", notes: "Sent premium Savanna quote with all options", createdAt: "2026-06-17" }], createdAt: "2026-06-05", updatedAt: "2026-06-17" }
    ],
    quotePayments: {},
    poPayments: {},
  };
}

/* ---------- small UI primitives ---------- */

function Toast({ message }) {
  if (!message) return null;
  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        background: "#4a3527",
        color: "#fff",
        padding: "11px 20px",
        borderRadius: 8,
        fontSize: 13.5,
        boxShadow: "0 8px 24px rgba(0,0,0,.25)",
        zIndex: 300,
      }}
    >
      {message}
    </div>
  );
}

function Badge({ children, tone = "model" }) {
  const tones = {
    model: { bg: "#f1e3d2", fg: "#8f3f1f" },
    draft: { bg: "#ece4d6", fg: "#6b5240" },
    sent: { bg: "#e0e9f0", fg: "#3a5d78" },
    accepted: { bg: "#e3ecdc", fg: "#5c7a4f" },
    received: { bg: "#e3ecdc", fg: "#5c7a4f" },
    declined: { bg: "#f5e2dd", fg: "#a3442e" },
    cancelled: { bg: "#f5e2dd", fg: "#a3442e" },
  };
  const t = tones[tone] || tones.model;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 9px",
        borderRadius: 20,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.2,
        background: t.bg,
        color: t.fg,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Btn({ children, onClick, variant = "ghost", size = "md", style, ...rest }) {
  const [isPressed, setIsPressed] = useState(false);
  
  const handleInteraction = () => {
    setIsPressed(true);
    if (onClick) {
      onClick();
    }
    setTimeout(() => setIsPressed(false), 200);
  };
  
  const base = {
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    fontFamily: "inherit",
    fontWeight: 600,
    transition: "opacity .15s, transform .08s",
  };
  const sizes = { md: { padding: "10px 16px", fontSize: 13.5 }, sm: { padding: "6px 11px", fontSize: 12.5 } };
  const variants = {
    primary: { background: "#b5552b", color: "#fff" },
    ghost: { background: "transparent", color: "#4a3527", border: "1px solid #e3d8c6" },
    text: { background: "none", color: "#b5552b", padding: "4px 6px", fontWeight: 600 },
    danger: { background: "transparent", color: "#a3442e", border: "1px solid #e6c9bf" },
  };
  return (
    <button
      onClick={handleInteraction}
      onTouchEnd={handleInteraction}
      style={{ 
        ...base, 
        ...sizes[size], 
        ...variants[variant], 
        ...style,
        opacity: isPressed ? 0.8 : 1,
        transform: isPressed ? "scale(0.98)" : "scale(1)",
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

function Field({ label, children, hint }) {
  return (
    <div style={{ marginBottom: 13 }}>
      {label && (
        <label
          style={{
            display: "block",
            fontSize: 12,
            fontWeight: 600,
            color: "#6b5240",
            marginBottom: 5,
            letterSpacing: 0.2,
          }}
        >
          {label}
        </label>
      )}
      {children}
      {hint && <div style={{ fontSize: 12, color: "#8a7a66", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

const inputStyle = {
  width: "100%",
  border: "1px solid #e3d8c6",
  borderRadius: 7,
  padding: "9px 11px",
  fontSize: 14,
  fontFamily: "inherit",
  background: "#fffdf9",
  color: "#2b2018",
  boxSizing: "border-box",
};

function Panel({ children, style, padded = true }) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e3d8c6",
        borderRadius: 10,
        boxShadow: "0 1px 2px rgba(43,32,24,.06), 0 4px 14px rgba(43,32,24,.06)",
        padding: padded ? 20 : 0,
        marginBottom: 20,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Modal({ onClose, children, width = 640 }) {
  const backdropRef = useRef(null);
  return (
    <div
      ref={backdropRef}
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(43,32,24,.45)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "40px 16px",
        overflowY: "auto",
        zIndex: 100,
      }}
    >
      <div
        className="modal-content"
        style={{
          background: "#fff",
          borderRadius: 13,
          maxWidth: width,
          width: "100%",
          padding: 26,
          boxShadow: "0 20px 60px rgba(0,0,0,.25)",
          marginBottom: 40,
          overflowX: "auto",
          boxSizing: "border-box",
        }}
      >
        {children}
      </div>
    </div>
  );
}

// Artifacts run in a sandboxed iframe where window.prompt/alert/confirm are
// typically blocked, so we use these in-app equivalents instead.

function PromptModal({ title, label, placeholder, confirmLabel = "Add", onCancel, onConfirm }) {
  const [value, setValue] = useState("");
  const inputRef = useRef(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);
  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  }
  return (
    <Modal onClose={onCancel} width={400}>
      <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 14px", fontSize: 18 }}>{title}</h3>
      <Field label={label}>
        <input
          ref={inputRef}
          style={inputStyle}
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
        />
      </Field>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 6 }}>
        <Btn variant="ghost" onClick={onCancel}>
          Cancel
        </Btn>
        <Btn variant="primary" onClick={submit}>
          {confirmLabel}
        </Btn>
      </div>
    </Modal>
  );
}

function ConfirmModal({ title, message, confirmLabel = "Delete", onCancel, onConfirm }) {
  return (
    <Modal onClose={onCancel} width={420}>
      <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 10px", fontSize: 18 }}>{title}</h3>
      <p style={{ fontSize: 13.5, color: "#4a3527", margin: "0 0 20px", lineHeight: 1.5 }}>{message}</p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <Btn variant="ghost" onClick={onCancel}>
          Cancel
        </Btn>
        <Btn variant="danger" onClick={onConfirm} style={{ background: "#a3442e", color: "#fff", border: "none" }}>
          {confirmLabel}
        </Btn>
      </div>
    </Modal>
  );
}

function Empty({ icon, text }) {
  return (
    <Panel>
      <div style={{ textAlign: "center", padding: "36px 20px", color: "#8a7a66", fontSize: 13.5 }}>
        <span style={{ fontSize: 28, display: "block", marginBottom: 6 }}>{icon}</span>
        {text}
      </div>
    </Panel>
  );
}

/* ============================================================
   MAIN APP
   ============================================================ */

export default function App() {
  const [db, setDb] = useState(null); // null = loading
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [syncStatus, setSyncStatus] = useState("checking"); // "checking" | "ok" | "unsynced" | "unavailable"
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const [toast, setToast] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Cross-tab "view this record" navigation — e.g. clicking "View quote" from a
  // customer record switches to the Quotes tab and opens that specific quote.
  const [pendingOpen, setPendingOpen] = useState(null); // { type: 'quote'|'po'|'customer'|'supplier'|'prospect', id }
  const openRecord = useCallback((type, id) => {
    const tabByType = { quote: "quotes", po: "pos", customer: "customers", supplier: "suppliers", prospect: "crm" };
    setTab(tabByType[type]);
    setPendingOpen({ type, id });
  }, []);
  const clearPendingOpen = useCallback(() => setPendingOpen(null), []);
  
  // Supabase REST API state
  const [supabaseConnected, setSupabaseConnected] = useState(false);
  const pollingIntervalRef = useRef(null);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2200);
  }, []);

  async function loadFromSupabase(isManualRefresh) {
    try {
      const data = await loadAllData();
      // ALWAYS use the data from Supabase, even if empty
      // Do NOT replace it with demo data
      if (data) {
        // Transform data to match app structure
        // Supabase categories table rows are objects like {id, name}; the app expects plain strings throughout.
        const rawCategories = (data.categories && data.categories.length) ? data.categories : DEFAULT_CATEGORIES.slice();
        data.categories = rawCategories.map((c) => (typeof c === "string" ? c : c.name)).filter(Boolean);
        
        // Convert items from Supabase format
        data.items = (data.items || []).map((i) => ({
          ...fromSupabaseFormat(i, "items"),
          currency: "AUD",
          // Use stored sell_price if set, otherwise derive from cost
          sellPrice: i.sell_price != null ? parseFloat(i.sell_price) : calcSellPrice(i.cost_aud),
        }));
        
        // Derive the model dropdown list from the actual model values present on items,
        // so edits made directly in Supabase (e.g. renaming "Campo" to "Austral Campo")
        // are reflected. Fall back to DEFAULT_MODELS only if no items have a model set.
        const modelsFromItems = Array.from(
          new Set(data.items.map((i) => i.model).filter(Boolean))
        ).sort((a, b) => a.localeCompare(b));
        data.models = modelsFromItems.length ? modelsFromItems : DEFAULT_MODELS.slice();

        // Convert customers from Supabase format
        data.customers = (data.customers || []).map((c) => fromSupabaseFormat(c, "customers"));
        
        // Convert suppliers from Supabase format
        data.suppliers = (data.suppliers || []).map((s) => fromSupabaseFormat(s, "suppliers"));
        
        // Convert CRM prospects from Supabase format
        data.crm = (data.crm || []).map((p) => {
          const converted = fromSupabaseFormat(p, "crm_prospects");
          if (p.activities && p.activities.length > 0) {
            console.log("📋 Prospect activities from Supabase:", p.name, "Activities:", JSON.stringify(p.activities, null, 2));
          }
          return converted;
        });
        
        // Convert quotes and purchase orders from Supabase format
        data.quotes = (data.quotes || []).map((q) => fromSupabaseFormat(q, "quotes"));
        data.pos = (data.pos || []).map((p) => fromSupabaseFormat(p, "purchase_orders"));
        
        data.fx = { usdAudRate: FALLBACK_USD_AUD_RATE, source: "default", updatedAt: null };
        // seq is a local-only counter, not stored in Supabase — derive it from existing data.
        // IMPORTANT: parseInt("Q-2026-001") returns NaN because parseInt stops at the first
        // non-digit character. A naive /(\d+)/ regex fix has its own trap: it matches the
        // FIRST digit run, which for "Q-2026-001" is "2026" (the year), not "001" (the real
        // sequence number) — that would wrongly inflate the floor. Both quotes and POs now
        // use clean "QU-####"/"PO-####" formats, so only numbers already in that exact
        // format count toward the floor; anything else (old-format or already-broken
        // "…-NaN" entries) is ignored, guaranteeing a clean start at the chosen floor.
        const extractQuoteSeq = (str) => {
          const m = String(str || "").match(/^QU-(\d+)$/);
          return m ? parseInt(m[1], 10) : 0;
        };
        const extractPoSeq = (str) => {
          const m = String(str || "").match(/^PO-(\d+)$/);
          return m ? parseInt(m[1], 10) : 0;
        };
        const maxQuoteNum = (data.quotes || []).reduce((max, q) => Math.max(max, extractQuoteSeq(q.number)), 0);
        const maxPoNum = (data.pos || []).reduce((max, p) => Math.max(max, extractPoSeq(p.number)), 0);
        // Quote numbers start at QU-1000, PO numbers start at PO-5001 — floor the
        // counters there even if none exist yet, or existing numbers are on the old scheme.
        data.seq = { quote: Math.max(1000, maxQuoteNum + 1), po: Math.max(5001, maxPoNum + 1) };

        // Sync quote milestones → customer invoices on load.
        // Merge future milestone dates into matching customer invoices (preserving existing entries).
        const customersByName = {};
        (data.customers || []).forEach(c => {
          if (c.name) customersByName[c.name.toLowerCase().trim()] = c;
        });
        const customersToUpdate = new Set();
        (data.quotes || []).forEach(q => {
          if (!q.party || !q.paymentMilestones || !q.paymentMilestones.length) return;
          const customer = customersByName[q.party.toLowerCase().trim()];
          if (!customer) return;
          const milestoneInvoices = q.paymentMilestones
            .filter(m => m.amount && m.due)
            .map(m => ({ amount: parseFloat(m.amount) || 0, invoiceMonth: m.due.slice(0, 7) }));
          if (!milestoneInvoices.length) return;
          const milestoneMonths = new Set(milestoneInvoices.map(i => i.invoiceMonth));
          const existingKept = (customer.invoices || []).filter(
            inv => inv && inv.invoiceMonth && !milestoneMonths.has(inv.invoiceMonth)
          );
          const merged = [...existingKept, ...milestoneInvoices]
            .sort((a, b) => (a.invoiceMonth || "").localeCompare(b.invoiceMonth || ""));
          if (JSON.stringify(merged) !== JSON.stringify(customer.invoices || [])) {
            customer.invoices = merged;
            customersToUpdate.add(customer);
          }
        });
        customersToUpdate.forEach(async (c) => {
          try {
            await supabaseREST("PATCH", `customers?id=eq.${c.id}`, { invoices: c.invoices });
          } catch (e) {
            console.error("Failed to sync milestones to customer on load:", e);
          }
        });

        setDb(data);
        setSyncStatus("ok");
        setLastSyncedAt(new Date().toISOString());
        if (isManualRefresh) showToast("Loaded latest data from Supabase");
      } else {
        // No data from Supabase = empty database, NOT demo data
        const emptyData = {
          items: [],
          quotes: [],
          pos: [],
          customers: [],
          suppliers: [],
          crm: [],
          categories: DEFAULT_CATEGORIES.slice(),
          models: DEFAULT_MODELS.slice(),
          fx: { usdAudRate: FALLBACK_USD_AUD_RATE, source: "default", updatedAt: null },
          seq: { quote: 1, po: 1 },
        };
        setDb(emptyData);
        setSyncStatus("ok");
        if (isManualRefresh) showToast("Supabase is empty");
      }
    } catch (e) {
      console.error("Load from Supabase error:", e);
      if (db === null) {
        // Only on initial load failure, use empty database
        const emptyData = {
          items: [],
          quotes: [],
          pos: [],
          customers: [],
          suppliers: [],
          crm: [],
          categories: DEFAULT_CATEGORIES.slice(),
          models: DEFAULT_MODELS.slice(),
          fx: { usdAudRate: FALLBACK_USD_AUD_RATE, source: "default", updatedAt: null },
          seq: { quote: 1, po: 1 },
        };
        setDb(emptyData);
      }
      setSyncStatus("unavailable");
      if (isManualRefresh) {
        showToast("Couldn't load data from Supabase");
      }
    }
  }

  // ---- Load from Supabase on mount ----
  useEffect(() => {
    loadFromSupabase(false);
  }, []);

  // ---- Initialize Supabase REST API polling on mount ----
  useEffect(() => {
    // DEBUG: Log environment variables
    console.log("🔍 DEBUG: REACT_APP_SUPABASE_URL =", process.env.REACT_APP_SUPABASE_URL);
    console.log("🔍 DEBUG: REACT_APP_SUPABASE_ANON_KEY exists?", !!process.env.REACT_APP_SUPABASE_ANON_KEY);
    if (process.env.REACT_APP_SUPABASE_ANON_KEY) {
      console.log("🔍 DEBUG: First 20 chars of key =", process.env.REACT_APP_SUPABASE_ANON_KEY.substring(0, 20));
    }
    setSupabaseConnected(true);
    
    // POLLING COMPLETELY DISABLED - causes data loss when importing
    // Data is synced via the explicit save function, not polling
    
    return () => {
      // cleanup
    };
  }, []);


  // ---- persist to cloud storage whenever db changes ----
  const dbRef = useRef(db);
  dbRef.current = db;
  const saveTimer = useRef(null);
  const hasLoadedOnce = useRef(false);

  useEffect(() => {
    if (db === null) return; // don't save while still loading
    if (!hasLoadedOnce.current) {
      // Skip saving immediately after the initial load — only save changes the
      // user actually makes, so we don't mask a real "storage unavailable" state
      // behind a write that just echoes back what we loaded.
      hasLoadedOnce.current = true;
      return;
    }
    setSaving(true);
    setSyncStatus("checking");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        // Data is saved directly to Supabase via REST API calls
        // when individual operations occur (create/update/delete)
        // Polling syncs changes from other devices
        setLoadError(null);
        setSyncStatus("ok");
        setLastSyncedAt(new Date().toISOString());
      } catch (e) {
        setLoadError("Could not sync with Supabase.");
        setSyncStatus("unavailable");
      } finally {
        setSaving(false);
      }
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [db]);

  function update(mutator) {
    setDb((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      mutator(next);
      return next;
    });
  }

  function nextNumber(kind, draftDb) {
    if (!draftDb.seq) draftDb.seq = { quote: 1000, po: 5001 };
    const n = draftDb.seq[kind]++;
    if (kind === "quote") {
      // Format: QU-1000, QU-1001, ... (no year, no zero-padding)
      return `QU-${n}`;
    }
    // Format: PO-5001, PO-5002, ... (no year, no zero-padding)
    return `PO-${n}`;
  }

  // ---- FX: try to fetch a live USD->AUD rate once data has loaded ----
  const [fxFetching, setFxFetching] = useState(false);
  const fxFetchedOnce = useRef(false);

  const fetchLiveRate = useCallback(async (silent) => {
    setFxFetching(true);
    try {
      const resp = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
      if (!resp.ok) throw new Error("bad response");
      const data = await resp.json();
      const rate = data && data.rates && data.rates.AUD;
      if (!rate || typeof rate !== "number") throw new Error("no rate in response");
      update((next) => {
        next.fx = { usdAudRate: rate, source: "live", updatedAt: new Date().toISOString() };
      });
      if (!silent) showToast("Live exchange rate updated");
    } catch (e) {
      if (!silent) showToast("Couldn't fetch a live rate — using your last saved rate instead");
    } finally {
      setFxFetching(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (db !== null && !fxFetchedOnce.current) {
      fxFetchedOnce.current = true;
      fetchLiveRate(true);
    }
  }, [db, fetchLiveRate]);

  function setManualRate(rate) {
    update((next) => {
      next.fx = { usdAudRate: rate, source: "manual", updatedAt: new Date().toISOString() };
    });
    showToast("Exchange rate updated");
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `austral-pricing-backup-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Backup file downloaded");
  }

  const [showFxModal, setShowFxModal] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);

  if (db === null) {
    return (
      <div style={{ ...appStyle, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <div style={{ color: "#8a7a66", fontSize: 14 }}>Loading your data…</div>
      </div>
    );
  }

  return (
    <div style={appStyle}>
      <style>{globalCss}</style>
      <div className="app">
        <header className="top">
          <div className="brand">
            <div className="mark">AM</div>
            <div>
              <h1>Austral Motorhomes & Platinum Pontoons</h1>
              <div className="sub">Supplier Pricing &amp; Order Manager</div>
            </div>
          </div>
          <div className="header-utilities">
            <button
              onClick={() => setShowSyncModal(true)}
              style={{
                background: "#eee3d1",
                border: "none",
                borderRadius: 8,
                padding: "8px 12px",
                fontSize: 12.5,
                fontWeight: 600,
                color: "#4a3527",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
                whiteSpace: "nowrap",
              }}
              title="Click to check sync status or refresh from cloud storage"
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  display: "inline-block",
                  background:
                    saving || syncStatus === "checking" ? "#c9a063" : syncStatus === "ok" ? "#5c7a4f" : "#a3442e",
                  flexShrink: 0,
                }}
              />
              <span>
                {saving || syncStatus === "checking"
                  ? "Syncing…"
                  : syncStatus === "ok"
                  ? "Synced"
                  : syncStatus === "unsynced"
                  ? "Not synced"
                  : "Sync unavailable"}
              </span>
            </button>
            <button
              style={{
                background: supabaseConnected ? "#c8e6c9" : "#eee3d1",
                border: "none",
                borderRadius: 8,
                padding: "8px 12px",
                fontSize: 12.5,
                fontWeight: 600,
                color: "#4a3527",
                cursor: "default",
                display: "flex",
                alignItems: "center",
                gap: 6,
                whiteSpace: "nowrap",
              }}
              title={supabaseConnected ? "Connected to Supabase" : "Connecting to Supabase..."}
            >
              <span style={{ fontSize: 14 }}>☁️</span>
              <span>{supabaseConnected ? "Supabase" : "Syncing"}</span>
            </button>
            <button
              onClick={() => setShowFxModal(true)}
              style={{
                background: "#eee3d1",
                border: "none",
                borderRadius: 8,
                padding: "8px 12px",
                fontSize: 12.5,
                fontWeight: 600,
                color: "#4a3527",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
                whiteSpace: "nowrap",
              }}
              title="Click to view or update the USD → AUD rate"
            >
              <span style={{ opacity: 0.7 }}>USD→AUD</span>
              <span>{db.fx.usdAudRate.toFixed(4)}</span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 6px",
                  borderRadius: 10,
                  background: db.fx.source === "live" ? "#e3ecdc" : db.fx.source === "manual" ? "#e0e9f0" : "#f5e2dd",
                  color: db.fx.source === "live" ? "#5c7a4f" : db.fx.source === "manual" ? "#3a5d78" : "#a3442e",
                }}
              >
                {db.fx.source === "live" ? "LIVE" : db.fx.source === "manual" ? "MANUAL" : "DEFAULT"}
              </span>
            </button>
            <Btn variant="ghost" size="sm" onClick={exportData} style={{ whiteSpace: "nowrap" }}>
              Export backup
            </Btn>
          </div>
        </header>

        <nav className="tabs" style={{ marginBottom: 0 }}>
          <button
            className="hamburger-menu"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            title="Menu"
            style={{
              display: "none",
              background: "none",
              border: "none",
              fontSize: 20,
              color: "#6b5240",
              cursor: "pointer",
              padding: "8px 12px",
              marginRight: 0,
            }}
          >
            ☰
          </button>

          {/* Desktop navigation (hidden on mobile) */}
          <div
            className="nav-groups-desktop"
            style={{
              display: "flex",
              gap: "12px",
              flex: 1,
              flexWrap: "wrap",
            }}
          >
            {/* Operations group */}
            <div style={{ display: "flex", gap: 2, alignItems: "center", marginRight: 12 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "#8a7a66", textTransform: "uppercase", letterSpacing: "0.3px", marginRight: 6 }}>Operations</span>
              {[
                ["pricebook", "Price Book"],
                ["quotes", "Quotes"],
                ["pos", "Purchase Orders"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={tab === key ? "active" : ""}
                  onClick={() => setTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            
            {/* Contacts group */}
            <div style={{ display: "flex", gap: 2, alignItems: "center", marginRight: 12, paddingLeft: 12, borderLeft: "1px solid #d3c9b8" }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "#8a7a66", textTransform: "uppercase", letterSpacing: "0.3px", marginRight: 6 }}>Contacts</span>
              {[
                ["suppliers", "Suppliers"],
                ["customers", "Customers"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={tab === key ? "active" : ""}
                  onClick={() => setTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            
            {/* Sales group */}
            <div style={{ display: "flex", gap: 2, alignItems: "center", paddingLeft: 12, borderLeft: "1px solid #d3c9b8" }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "#8a7a66", textTransform: "uppercase", letterSpacing: "0.3px", marginRight: 6 }}>Sales</span>
              {[
                ["crm", "Prospects"],
                ["shipments", "Shipments"],
                ["dashboard", "Dashboard"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={tab === key ? "active" : ""}
                  onClick={() => setTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </nav>

        {/* Mobile dropdown menu */}
        {mobileMenuOpen && (
          <div
            style={{
              display: "none",
              background: "#f9f7f2",
              border: "1px solid #d3c9b8",
              borderRadius: "8px",
              marginBottom: "14px",
              padding: "8px",
              zIndex: 1000,
            }}
            className="mobile-menu"
          >
            <div style={{ marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid #e3d8c6" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#8a7a66", textTransform: "uppercase", marginBottom: 6 }}>Operations</div>
              {[
                ["pricebook", "Price Book"],
                ["quotes", "Quotes"],
                ["pos", "Purchase Orders"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 12px",
                    marginBottom: 2,
                    background: tab === key ? "#4a3527" : "#fff",
                    color: tab === key ? "#fff" : "#6b5240",
                    border: "1px solid #d3c9b8",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "13px",
                    fontWeight: 500,
                  }}
                  className={tab === key ? "active" : ""}
                  onClick={() => {
                    setTab(key);
                    setMobileMenuOpen(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div style={{ marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid #e3d8c6" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#8a7a66", textTransform: "uppercase", marginBottom: 6 }}>Contacts</div>
              {[
                ["suppliers", "Suppliers"],
                ["customers", "Customers"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 12px",
                    marginBottom: 2,
                    background: tab === key ? "#4a3527" : "#fff",
                    color: tab === key ? "#fff" : "#6b5240",
                    border: "1px solid #d3c9b8",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "13px",
                    fontWeight: 500,
                  }}
                  onClick={() => {
                    setTab(key);
                    setMobileMenuOpen(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#8a7a66", textTransform: "uppercase", marginBottom: 6 }}>Sales</div>
              {[
                ["crm", "Prospects"],
                ["shipments", "Shipments"],
                ["dashboard", "Dashboard"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 12px",
                    marginBottom: 2,
                    background: tab === key ? "#4a3527" : "#fff",
                    color: tab === key ? "#fff" : "#6b5240",
                    border: "1px solid #d3c9b8",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "13px",
                    fontWeight: 500,
                  }}
                  onClick={() => {
                    setTab(key);
                    setMobileMenuOpen(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {loadError && (
          <div
            style={{
              background: "#fbeae5",
              border: "1px solid #e6c9bf",
              color: "#a3442e",
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: 13,
              marginTop: 12,
            }}
          >
            {loadError}
          </div>
        )}

        {tab === "pricebook" && <PriceBookTab db={db} update={update} showToast={showToast} />}
        {tab === "quotes" && (
          <DocsTab
            kind="quote"
            db={db}
            update={update}
            showToast={showToast}
            nextNumber={nextNumber}
            pendingOpen={pendingOpen}
            clearPendingOpen={clearPendingOpen}
            openRecord={openRecord}
          />
        )}
        {tab === "pos" && (
          <DocsTab
            kind="po"
            db={db}
            update={update}
            showToast={showToast}
            nextNumber={nextNumber}
            pendingOpen={pendingOpen}
            clearPendingOpen={clearPendingOpen}
            openRecord={openRecord}
          />
        )}
        {tab === "suppliers" && (
          <ContactsTab
            kind="supplier"
            db={db}
            update={update}
            showToast={showToast}
            pendingOpen={pendingOpen}
            clearPendingOpen={clearPendingOpen}
            openRecord={openRecord}
          />
        )}
        {tab === "customers" && (
          <ContactsTab
            kind="customer"
            db={db}
            update={update}
            showToast={showToast}
            nextNumber={nextNumber}
            pendingOpen={pendingOpen}
            clearPendingOpen={clearPendingOpen}
            openRecord={openRecord}
          />
        )}
        {tab === "crm" && (
          <CRMTab
            db={db}
            update={update}
            showToast={showToast}
            nextNumber={nextNumber}
            pendingOpen={pendingOpen}
            clearPendingOpen={clearPendingOpen}
            openRecord={openRecord}
          />
        )}
        {tab === "dashboard" && (
          <DashboardTab db={db} setTab={setTab} openRecord={openRecord} />
        )}
        {tab === "shipments" && (
          <ShipmentsTab db={db} update={update} showToast={showToast} openRecord={openRecord} />
        )}
      </div>
      <Toast message={toast} />
      {showFxModal && (
        <FxModal
          fx={db.fx}
          fetching={fxFetching}
          onClose={() => setShowFxModal(false)}
          onRefresh={() => fetchLiveRate(false)}
          onSetManual={setManualRate}
        />
      )}
      {showSyncModal && (
        <SyncModal
          syncStatus={syncStatus}
          lastSyncedAt={lastSyncedAt}
          loadError={loadError}
          onClose={() => setShowSyncModal(false)}
          onRefresh={async () => {
            await loadFromSupabase(true);
          }}
        />
      )}

    </div>
  );
}

const appStyle = {
  background: "#f6f1e7",
  color: "#2b2018",
  fontFamily: "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
  minHeight: "100vh",
};

const globalCss = `
  .app{max-width:1180px;margin:0 auto;padding:0 20px 80px;}
  header.top{display:flex;align-items:center;justify-content:space-between;padding:22px 0 18px;border-bottom:3px solid #b5552b;margin-bottom:14px;flex-wrap:wrap;gap:10px;}
  .brand{display:flex;align-items:center;gap:12px;}
  .brand .mark{width:42px;height:42px;border-radius:9px;background:linear-gradient(155deg,#b5552b,#8f3f1f);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:18px;font-family:Georgia,serif;letter-spacing:-1px;flex-shrink:0;}
  .brand h1{font-family:Georgia,serif;font-size:21px;margin:0;color:#4a3527;letter-spacing:.2px;}
  .brand .sub{font-size:12px;color:#8a7a66;margin-top:1px;letter-spacing:.3px;}
  .header-utilities{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
  @media (max-width:600px){.header-utilities{width:100%;justify-content:flex-start;}}
  nav.tabs{
    display:flex;gap:4px;background:#eee3d1;padding:4px;border-radius:11px;
    margin:0 0 22px;overflow-x:auto;-webkit-overflow-scrolling:touch;
  }
  nav.tabs button{border:none;background:transparent;padding:9px 16px;font-size:13.5px;font-weight:600;color:#6b5240;border-radius:8px;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;}
  nav.tabs button.active{background:#4a3527;color:#fff;}
  
  @media (max-width:800px){
    nav.tabs{
      display:flex;
      gap:0;
      padding:0;
      background:transparent;
      margin:0 0 16px;
      justify-content:space-between;
      align-items:center;
    }
    nav.tabs .hamburger-menu{
      display:block !important;
    }
    nav.tabs .nav-groups-desktop{
      display:none !important;
    }
    .mobile-menu{
      display:block !important;
    }
  }
  h2.section-title{font-family:Georgia,serif;font-size:22px;color:#4a3527;margin:28px 0 4px;}
  p.section-desc{color:#8a7a66;font-size:13.5px;margin:0 0 18px;}
  table{width:100%;border-collapse:collapse;font-size:13.5px;}
  th{text-align:left;color:#8a7a66;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;padding:8px 10px;border-bottom:2px solid #e3d8c6;font-weight:700;}
  td{padding:10px 10px;border-bottom:1px solid #e3d8c6;vertical-align:middle;}
  tr:last-child td{border-bottom:none;}
  .num{text-align:right;font-variant-numeric:tabular-nums;}
  .muted{color:#8a7a66;}
  .cat-block{margin-bottom:22px;}
  .cat-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
  .cat-head h4{font-family:Georgia,serif;font-size:15px;color:#4a3527;margin:0;}
  .cat-count{font-size:11.5px;color:#8a7a66;font-weight:600;}
  .toolbar-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:13px;}
  .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:13px;}
  @media (max-width:680px){.grid2,.grid3{grid-template-columns:1fr;}}
  .builder-grid{display:grid;grid-template-columns:1.1fr 1fr;gap:20px;}
  @media (max-width:900px){.builder-grid{grid-template-columns:1fr;}}
  .doc-split-grid{display:grid;grid-template-columns:1fr 1fr;gap:22px;align-items:start;}
  @media (max-width:900px){.doc-split-grid{grid-template-columns:1fr;}}
  .line-item-row{display:grid;grid-template-columns:1fr 50px 60px 70px 70px 80px 30px;gap:6px;align-items:start;margin-bottom:8px;}
  @media (max-width:680px){.line-item-row{grid-template-columns:1fr 1fr;}}
  .totals-row{display:flex;justify-content:space-between;font-size:13.5px;padding:4px 0;}
  .totals-row.grand{font-weight:800;font-size:16px;color:#4a3527;border-top:1px solid #e3d8c6;margin-top:6px;padding-top:10px;}
  .doc-meta{display:flex;gap:18px;flex-wrap:wrap;font-size:12.5px;color:#8a7a66;margin-bottom:14px;}
  .doc-paper{background:#fff;border:1px solid #e3d8c6;border-radius:10px;padding:40px;line-height:1.7;}
  .doc-paper .doc-header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #b5552b;padding-bottom:20px;margin-bottom:30px;gap:20px;}
  .doc-paper h2{font-family:Georgia,serif;color:#4a3527;margin:0 0 6px;font-size:26px;font-weight:700;}
  .doc-paper h3{font-family:Georgia,serif;color:#6b5240;margin:24px 0 12px;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;}
  .doc-paper table{margin:20px 0 30px;border-collapse:collapse;width:100%;}
  .doc-paper th{text-align:left;border-bottom:2px solid #b5552b;padding:12px 8px;font-size:12px;font-weight:700;color:#4a3527;background:#f9f7f2;}
  .doc-paper td{padding:14px 8px;border-bottom:1px solid #e3d8c6;font-size:14px;}
  .doc-paper .num{text-align:right;}
  .doc-paper .totals-row{display:flex;justify-content:space-between;padding:10px 0;font-size:14px;}
  .doc-paper .grand{font-weight:800;font-size:18px;border-top:2px solid #b5552b;border-bottom:1px solid #e3d8c6;margin-top:20px;padding:16px 0;}
  @media print{
    .no-print{display:none !important;}
  }
  @media (max-width:640px){
    .section-header{flex-direction:column;align-items:flex-start;gap:6px;}
    .toolbar-row{flex-direction:column;align-items:flex-start;}
    .doc-paper{padding:20px 14px;}
    .doc-paper .doc-header{flex-direction:column;gap:12px;}
    .doc-paper table{font-size:12px;}
    .doc-paper td,.doc-paper th{padding:8px 4px;}
    .panel{padding:14px;}
    .modal-backdrop{padding:16px 8px !important;}
    .modal-content{padding:16px !important;}
    table{font-size:12px;}
    td,th{padding:8px 4px;}
  }
`;

/* ============================================================
   PRICE BOOK TAB
   ============================================================ */

/* ============================================================
   FX RATE MODAL
   ============================================================ */

function FxModal({ fx, fetching, onClose, onRefresh, onSetManual }) {
  const [manualValue, setManualValue] = useState(fx.usdAudRate.toFixed(4));
  const [error, setError] = useState("");

  function handleSave() {
    const parsed = parseFloat(manualValue);
    if (isNaN(parsed) || parsed <= 0) {
      setError("Please enter a valid positive number, e.g. 1.41");
      return;
    }
    onSetManual(parsed);
    onClose();
  }

  return (
    <Modal onClose={onClose} width={460}>
      <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 6px", fontSize: 19 }}>
        USD → AUD exchange rate
      </h3>
      <p style={{ fontSize: 13, color: "#8a7a66", margin: "0 0 16px" }}>
        Used to convert USD supplier costs to AUD in quotes and purchase orders. This is a planning estimate —
        always verify against your bank or supplier's actual rate before relying on it for a real transaction.
      </p>

      <div
        style={{
          background: "#f6f1e7",
          border: "1px solid #e3d8c6",
          borderRadius: 8,
          padding: "12px 14px",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontSize: 22, fontWeight: 700, color: "#4a3527" }}>1 USD = {fx.usdAudRate.toFixed(4)} AUD</span>
          <Badge tone={fx.source === "live" ? "accepted" : fx.source === "manual" ? "sent" : "declined"}>
            {fx.source === "live" ? "Live" : fx.source === "manual" ? "Manual" : "Default estimate"}
          </Badge>
        </div>
        <div style={{ fontSize: 12, color: "#8a7a66", marginTop: 6 }}>
          {fx.updatedAt ? `Last updated ${fmtDateTime(fx.updatedAt)}` : "Not yet updated this session"}
        </div>
      </div>

      <Btn variant="ghost" onClick={onRefresh} style={{ width: "100%", marginBottom: 18, justifyContent: "center" }}>
        {fetching ? "Fetching live rate…" : "Refresh live rate now"}
      </Btn>

      <div style={{ height: 1, background: "#e3d8c6", margin: "0 0 18px" }} />

      <Field label="Or set the rate manually">
        <input
          style={inputStyle}
          type="number"
          step="0.0001"
          min="0"
          value={manualValue}
          onChange={(e) => setManualValue(e.target.value)}
        />
      </Field>

      {error && (
        <div
          style={{
            background: "#fbeae5",
            border: "1px solid #e6c9bf",
            color: "#a3442e",
            borderRadius: 8,
            padding: "9px 12px",
            fontSize: 13,
            marginBottom: 10,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 6 }}>
        <Btn variant="ghost" onClick={onClose}>
          Cancel
        </Btn>
        <Btn variant="primary" onClick={handleSave}>
          Use this rate
        </Btn>
      </div>
    </Modal>
  );
}

/* ============================================================
   SYNC STATUS MODAL
   ============================================================ */

function SyncModal({ syncStatus, lastSyncedAt, loadError, onClose, onRefresh }) {
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  const statusCopy = {
    checking: { label: "Checking…", color: "#c9a063", desc: "Confirming the latest save with cloud storage." },
    ok: { label: "Synced", color: "#5c7a4f", desc: "Your last change was confirmed as saved to cloud storage." },
    unsynced: {
      label: "Not synced",
      color: "#a3442e",
      desc: "Your last change could not be confirmed as saved. This most commonly happens when the artifact hasn't been published yet — storage only works on published artifacts.",
    },
    unavailable: {
      label: "Sync unavailable",
      color: "#a3442e",
      desc: "Cloud storage isn't reachable right now. If you haven't published this artifact via the Publish button in the artifact panel, that's required before any data can be saved or synced at all.",
    },
  };
  const current = statusCopy[syncStatus] || statusCopy.checking;

  return (
    <Modal onClose={onClose} width={480}>
      <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 6px", fontSize: 19 }}>
        Sync status
      </h3>
      <p style={{ fontSize: 13, color: "#8a7a66", margin: "0 0 16px" }}>
        This app saves to cloud storage tied to your Claude account, which is what lets the same data show up on
        other devices. There's no separate "sync" step beyond saving and loading — this panel shows whether that's
        actually working right now.
      </p>

      <div
        style={{
          background: "#f6f1e7",
          border: "1px solid #e3d8c6",
          borderRadius: 8,
          padding: "12px 14px",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: current.color, display: "inline-block" }} />
          <span style={{ fontSize: 17, fontWeight: 700, color: "#4a3527" }}>{current.label}</span>
        </div>
        <div style={{ fontSize: 12.5, color: "#6b5240", marginTop: 8, lineHeight: 1.5 }}>{current.desc}</div>
        <div style={{ fontSize: 12, color: "#8a7a66", marginTop: 8 }}>
          {lastSyncedAt ? `Last confirmed save: ${fmtDateTime(lastSyncedAt)}` : "No save has been confirmed yet this session."}
        </div>
      </div>

      {loadError && (
        <div
          style={{
            background: "#fbeae5",
            border: "1px solid #e6c9bf",
            color: "#a3442e",
            borderRadius: 8,
            padding: "9px 12px",
            fontSize: 12.5,
            marginBottom: 16,
          }}
        >
          {loadError}
        </div>
      )}

      <Btn variant="ghost" onClick={handleRefresh} style={{ width: "100%", justifyContent: "center" }}>
        {refreshing ? "Checking cloud storage…" : "Refresh now — check for changes from another device"}
      </Btn>
      <p style={{ fontSize: 11.5, color: "#8a7a66", margin: "10px 0 0", lineHeight: 1.5 }}>
        This re-reads whatever is currently saved in cloud storage and replaces what's on screen with it — useful
        after making changes on another device. If status shows "Not synced" or "Sync unavailable" even after
        refreshing, the most likely cause is that this artifact hasn't been published yet (Publish button in the
        artifact panel) — until it's published, storage doesn't work at all, on any device.
      </p>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
        <Btn variant="primary" onClick={onClose}>
          Close
        </Btn>
      </div>
    </Modal>
  );
}

function PriceBookTab({ db, update, showToast }) {
  const [modelFilter, setModelFilter] = useState("");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("model");
  const [editingItem, setEditingItem] = useState(undefined); // undefined = closed, null = new, obj = editing
  const [pendingDelete, setPendingDelete] = useState(null);
  const [selectedContact, setSelectedContact] = useState(null); // mobile detail view
  const isMobile = useIsMobile();
  const [showCategoryManager, setShowCategoryManager] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  if (!db || !db.items) {
    return (
      <section>
        <h2 className="section-title">Price Book</h2>
        <p className="section-desc">Loading data...</p>
      </section>
    );
  }

  let items = db.items.slice();
  if (modelFilter) items = items.filter((i) => i.model === modelFilter);
  if (search) {
    const s = search.toLowerCase();
    items = items.filter(
      (i) =>
        i.name.toLowerCase().includes(s) ||
        (i.supplier || "").toLowerCase().includes(s) ||
        (i.category || "").toLowerCase().includes(s)
    );
  }

  if (sortBy === "name") items.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  else if (sortBy === "cost-desc") items.sort((a, b) => b.cost - a.cost);
  else if (sortBy === "cost-asc") items.sort((a, b) => a.cost - b.cost);
  else if (sortBy === "updated") items.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  else items.sort((a, b) => (a.model || "").localeCompare(b.model || "") || (a.name || "").localeCompare(b.name || ""));

  function saveItem(payload, editing) {
    // Save to Supabase first, then update local state
    (async () => {
      try {
        if (editing) {
          // Update existing item in Supabase
          const updatePayload = toSupabaseFormat({ ...payload, updatedAt: todayISO() }, "items");
          await supabaseREST("PATCH", `items?id=eq.${editing.id}`, updatePayload);
          // Then update local state
          update((next) => {
            const target = next.items.find((i) => i.id === editing.id);
            Object.assign(target, payload, { updatedAt: todayISO() });
          });
        } else {
          // Create new item in Supabase — let Postgres generate the real UUID
          const newItem = {
            createdAt: todayISO(),
            updatedAt: todayISO(),
            ...payload,
          };
          const createPayload = toSupabaseFormat(newItem, "items");
          delete createPayload.id;
          const result = await supabaseREST("POST", "items", createPayload);
          const savedRow = Array.isArray(result) ? result[0] : result;
          const savedItem = { ...newItem, ...fromSupabaseFormat(savedRow, "items"), id: savedRow.id };
          // Then update local state
          update((next) => {
            next.items.push(savedItem);
          });
        }
        setEditingItem(undefined);
        showToast(editing ? "Item updated" : "Item added");
      } catch (err) {
        showToast(`Error saving item: ${err.message}`);
        console.error("Save item error:", err);
      }
    })();
  }

  function deleteItem(item) {
    setPendingDelete(item);
  }

  function addModel(name) {
    update((next) => {
      if (!next.models.includes(name)) {
        next.models.push(name);
        next.models.sort((a, b) => a.localeCompare(b));
      }
    });
  }
  function addCategory(name) {
    update((next) => {
      if (!next.categories.includes(name)) next.categories.push(name);
    });
  }

  return (
    <section>
      <div className="toolbar-row">
        <div>
          <h2 className="section-title" style={{ marginTop: 8 }}>
            Price Book
          </h2>
          <p className="section-desc">
            Supplier costs for every model, variation, and option. Add new lines any time as your range grows.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="ghost" onClick={() => setShowImportModal(true)} style={{ fontSize: 13 }}>
            📥 Import CSV
          </Btn>
          <Btn variant="ghost" onClick={() => setShowCategoryManager(true)} style={{ fontSize: 13 }}>
            ⚙️ Categories
          </Btn>
          <Btn variant="primary" onClick={() => setEditingItem(null)}>
            + Add price item
          </Btn>
        </div>
      </div>

      <Panel style={{ padding: "16px 20px" }}>
        <div className="grid3" style={{ marginBottom: 0 }}>
          <Field label="Filter by model">
            <select style={inputStyle} value={modelFilter} onChange={(e) => setModelFilter(e.target.value)}>
              <option value="">All models</option>
              {db.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Search">
            <input
              style={inputStyle}
              type="text"
              placeholder="Search item or supplier…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <Field label="Sort by">
            <select style={inputStyle} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="model">Model, then name</option>
              <option value="name">Name</option>
              <option value="cost-desc">Cost (high to low)</option>
              <option value="cost-asc">Cost (low to high)</option>
              <option value="updated">Recently updated</option>
            </select>
          </Field>
        </div>
      </Panel>

      {items.length === 0 ? (
        <Empty
          icon="📋"
          text={db.items.length === 0 ? "No price items yet. Add your first supplier cost to get started." : "No items match your filters."}
        />
      ) : sortBy === "model" ? (
        groupByModelThenCategory(items).map(([model, byCat]) => (
          <Panel key={model}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 14,
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <Badge tone="model">{model}</Badge>
              <span className="cat-count">
                {byCat.reduce((s, [, list]) => s + list.length, 0)} item
                {byCat.reduce((s, [, list]) => s + list.length, 0) === 1 ? "" : "s"}
              </span>
            </div>
            {byCat.map(([cat, list]) => (
              <div className="cat-block" key={cat}>
                <div className="cat-head">
                  <h4>{cat}</h4>
                  <span className="cat-count">
                    {list.length} item{list.length === 1 ? "" : "s"}
                  </span>
                </div>
                <ItemsTable list={list} hideModelCol onEdit={setEditingItem} onDelete={deleteItem} fx={db.fx} />
              </div>
            ))}
          </Panel>
        ))
      ) : isMobile ? (
        <Panel style={{ padding: 0 }}>
          {items.map((item) => (
            <div
              key={item.id}
              onClick={() => setEditingItem(item)}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 16px", borderBottom: "1px solid #f0e8d9", cursor: "pointer" }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#4a3527" }}>{item.model} — {item.name}</div>
                <div style={{ fontSize: 12, color: "#8a7a66", marginTop: 2 }}>
                  {item.category}{item.supplier ? ` · ${item.supplier}` : ""}{item.sellPrice ? ` · $${item.sellPrice.toLocaleString()}` : ""}
                </div>
              </div>
              <span style={{ color: "#b5552b", fontSize: 18 }}>›</span>
            </div>
          ))}
        </Panel>
      ) : (
        <Panel style={{ padding: 0 }}>
          <ItemsTable list={items} onEdit={setEditingItem} onDelete={deleteItem} fx={db.fx} />
        </Panel>
      )}

      {editingItem !== undefined && (
        <ItemModal
          editing={editingItem}
          models={db.models}
          categories={db.categories}
          suppliers={db.suppliers}
          fx={db.fx}
          onAddModel={addModel}
          onAddCategory={addCategory}
          onCancel={() => setEditingItem(undefined)}
          onSave={saveItem}
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title="Delete price item?"
          message={`Delete "${pendingDelete.name}" from the price book? This won't affect quotes or POs already created.`}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            try {
              // Delete from Supabase first
              console.log(`🗑️ Deleting item ${pendingDelete.id} from Supabase`);
              await supabaseREST("DELETE", "items", null, `id=eq.${pendingDelete.id}`);
              console.log(`✅ Successfully deleted item ${pendingDelete.id} from Supabase`);
              
              // Then update local state
              update((next) => {
                next.items = next.items.filter((i) => i.id !== pendingDelete.id);
              });
              showToast("Item deleted");
            } catch (err) {
              console.error("Delete error:", err);
              showToast(`❌ Failed to delete: ${err.message}`);
            } finally {
              setPendingDelete(null);
            }
          }}
        />
      )}

      {showCategoryManager && (
        <CategoryManager
          categories={db.categories}
          onUpdate={(newCategories) => {
            update((next) => {
              next.categories = newCategories;
            });
            showToast("Categories updated");
            setShowCategoryManager(false);
          }}
          onCancel={() => setShowCategoryManager(false)}
        />
      )}

      {showImportModal && (
        <ImportCSVModal
          models={db.models}
          categories={db.categories}
          onImport={(items) => {
            update((next) => {
              items.forEach((item) => {
                next.items.push(item);
              });
            });
            showToast(`${items.length} items imported`);
            setShowImportModal(false);
          }}
          onCancel={() => setShowImportModal(false)}
          onAddModel={addModel}
          onAddCategory={addCategory}
          showToast={showToast}
        />
      )}
    </section>
  );
}

function groupByModelThenCategory(items) {
  const byModel = {};
  items.forEach((i) => {
    (byModel[i.model] = byModel[i.model] || []).push(i);
  });
  return Object.keys(byModel)
    .sort()
    .map((model) => {
      const list = byModel[model];
      const byCat = {};
      list.forEach((i) => {
        const c = i.category || "Other";
        (byCat[c] = byCat[c] || []).push(i);
      });
      const catEntries = Object.keys(byCat)
        .sort()
        .map((c) => [c, byCat[c].slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""))]);
      return [model, catEntries];
    });
}

function ItemsTable({ list, hideModelCol, onEdit, onDelete, fx }) {
  const sorted = list.slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return (
    <table>
      <thead>
        <tr>
          <th>Item</th>
          {!hideModelCol && (
            <>
              <th>Model</th>
              <th>Category</th>
            </>
          )}
          <th>Supplier</th>
          <th className="num">Cost</th>
          <th className="num">Sell price</th>
          <th>Updated</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((i) => {
          const currency = i.currency || "AUD";
          const sellPrice = i.sellPrice != null ? i.sellPrice : calcSellPrice(i.cost);
          return (
            <tr key={i.id}>
              <td>
                <strong>{i.name}</strong>
                {i.notes && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{i.notes}</div>}
              </td>
              {!hideModelCol && (
                <>
                  <td>
                    <Badge tone="model">{i.model}</Badge>
                  </td>
                  <td className="muted">{i.category || "Other"}</td>
                </>
              )}
              <td>{i.supplier || "—"}</td>
              <td className="num">
                {fmtMoney(i.cost, currency)}
                {currency === "USD" && (
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                    ≈ {fmtMoney(toAUD(i.cost, "USD", fx ? fx.usdAudRate : FALLBACK_USD_AUD_RATE), "AUD")} AUD
                  </div>
                )}
              </td>
              <td className="num">
                {fmtMoney(sellPrice, currency)}
                {currency === "USD" && (
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                    ≈ {fmtMoney(toAUD(sellPrice, "USD", fx ? fx.usdAudRate : FALLBACK_USD_AUD_RATE), "AUD")} AUD
                  </div>
                )}
              </td>
              <td className="muted">{fmtDate(i.updatedAt)}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                <Btn variant="text" size="sm" onClick={() => onEdit(i)}>
                  Edit
                </Btn>{" "}
                <button
                  onClick={() => onDelete(i)}
                  title="Delete"
                  style={{ background: "none", border: "none", color: "#a3442e", cursor: "pointer", fontSize: 16, padding: 4 }}
                >
                  ✕
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CategoryManager({ categories, onUpdate, onCancel }) {
  const [editingIndex, setEditingIndex] = useState(null);
  const [editingValue, setEditingValue] = useState("");
  const [newCategory, setNewCategory] = useState("");

  function handleStartEdit(index) {
    setEditingIndex(index);
    setEditingValue(categories[index]);
  }

  function handleSaveEdit(index) {
    const trimmed = editingValue.trim();
    if (!trimmed) {
      return;
    }
    const updated = categories.slice();
    updated[index] = trimmed;
    onUpdate(updated);
    setEditingIndex(null);
  }

  function handleDeleteCategory(index) {
    const updated = categories.slice();
    updated.splice(index, 1);
    onUpdate(updated);
  }

  function handleAddCategory() {
    const trimmed = newCategory.trim();
    if (!trimmed || categories.includes(trimmed)) {
      return;
    }
    onUpdate([...categories, trimmed]);
    setNewCategory("");
  }

  return (
    <Modal onClose={onCancel}>
      <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 16px", fontSize: 19 }}>
        Manage Categories
      </h3>

      <div style={{ marginBottom: 18 }}>
        <h4 style={{ color: "#6b5240", fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
          Existing Categories
        </h4>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {categories.map((cat, idx) => (
            <div key={idx} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {editingIndex === idx ? (
                <>
                  <input
                    style={{ ...inputStyle, flex: 1 }}
                    type="text"
                    value={editingValue}
                    onChange={(e) => setEditingValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveEdit(idx);
                      if (e.key === "Escape") setEditingIndex(null);
                    }}
                    autoFocus
                  />
                  <button
                    onClick={() => handleSaveEdit(idx)}
                    style={{
                      background: "#5c7a4f",
                      color: "white",
                      border: "none",
                      borderRadius: 4,
                      padding: "6px 12px",
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    ✓
                  </button>
                  <button
                    onClick={() => setEditingIndex(null)}
                    style={{
                      background: "#d3c9b8",
                      color: "#6b5240",
                      border: "none",
                      borderRadius: 4,
                      padding: "6px 12px",
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    ✕
                  </button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1, padding: "6px 12px", background: "#f6f1e7", borderRadius: 4, fontSize: 13, color: "#4a3527" }}>
                    {cat}
                  </span>
                  <button
                    onClick={() => handleStartEdit(idx)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#b5552b",
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: 600,
                      padding: 0,
                    }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDeleteCategory(idx)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#a3442e",
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: 600,
                      padding: 0,
                    }}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 18, paddingBottom: 18, borderBottom: "1px solid #d3c9b8" }}>
        <h4 style={{ color: "#6b5240", fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
          Add New Category
        </h4>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ ...inputStyle, flex: 1 }}
            type="text"
            placeholder="e.g. Awning & Shade"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddCategory();
            }}
          />
          <button
            onClick={handleAddCategory}
            style={{
              background: "#b5552b",
              color: "white",
              border: "none",
              borderRadius: 4,
              padding: "6px 12px",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Add
          </button>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <Btn variant="primary" onClick={onCancel}>
          Done
        </Btn>
      </div>
    </Modal>
  );
}

function ItemModal({ editing, models, categories, suppliers, fx, onAddModel, onAddCategory, onCancel, onSave }) {
  // categories from Supabase may be objects like {id, name}; normalise to plain strings
  const categoryNames = (categories || []).map((c) => (typeof c === "string" ? c : c.name)).filter(Boolean);
  const modelNames = (models || []).map((m) => (typeof m === "string" ? m : m.name)).filter(Boolean);
  const supplierNames = (suppliers || [])
    .map((s) => (typeof s === "string" ? s : s.name))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const [name, setName] = useState(editing ? editing.name : "");
  // Extract name if model is an object, otherwise use string directly
  const defaultModel = models && models[0] ? (typeof models[0] === "string" ? models[0] : models[0].name || "") : "";
  const defaultCategory = categories && categories[0] ? (typeof categories[0] === "string" ? categories[0] : categories[0].name || "") : "";
  const [model, setModel] = useState(editing ? editing.model : defaultModel);
  const [category, setCategory] = useState(editing ? editing.category : defaultCategory);
  const [currency, setCurrency] = useState(editing ? editing.currency || "AUD" : "AUD");
  const [cost, setCost] = useState(editing ? String(editing.cost) : "");
  const [sellPrice, setSellPrice] = useState(
    editing ? String(editing.sellPrice != null ? editing.sellPrice : calcSellPrice(editing.cost)) : ""
  );
  const [supplier, setSupplier] = useState(editing ? editing.supplier || "" : "");
  const [notes, setNotes] = useState(editing ? editing.notes || "" : "");
  const [itemDescription, setItemDescription] = useState(editing ? editing.itemDescription || "" : "");
  const [error, setError] = useState("");
  const [promptMode, setPromptMode] = useState(null); // null | "model" | "category"

  // Track the cost value last used to auto-calc the sell price, so we only
  // overwrite a manual sell price edit when cost itself actually changes.
  const lastCostForCalc = useRef(editing ? editing.cost : null);

  function handleCostChange(value) {
    setCost(value);
    const parsed = parseFloat(value);
    if (!isNaN(parsed) && parsed >= 0) {
      setSellPrice(String(calcSellPrice(parsed)));
      lastCostForCalc.current = parsed;
    }
  }

  function handleSave() {
    const trimmedName = name.trim();
    const parsedCost = parseFloat(cost);
    const parsedSell = parseFloat(sellPrice);
    if (!trimmedName) {
      setError("Please enter an item name.");
      return;
    }
    if (isNaN(parsedCost) || parsedCost < 0) {
      setError("Please enter a valid cost.");
      return;
    }
    if (isNaN(parsedSell) || parsedSell < 0) {
      setError("Please enter a valid sell price.");
      return;
    }
    onSave(

      {
        name: trimmedName,
        model,
        category,
        currency,
        cost: parsedCost,
        sellPrice: parsedSell,
        supplier: supplier.trim(),
        notes: notes.trim(),
        itemDescription: itemDescription.trim(),
      },
      editing
    );
  }

  const parsedCostPreview = parseFloat(cost);
  const showAudPreview = currency === "USD" && !isNaN(parsedCostPreview) && parsedCostPreview > 0;
  const parsedSellPreview = parseFloat(sellPrice);
  const showSellAudPreview = currency === "USD" && !isNaN(parsedSellPreview) && parsedSellPreview > 0;

  return (
    <Modal onClose={onCancel}>
      <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 16px", fontSize: 19 }}>
        {editing ? "Edit price item" : "Add price item"}
      </h3>
      <Field label="Item name">
        <input
          style={inputStyle}
          type="text"
          placeholder="e.g. Composite roof panel — 2.4m"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="grid2">
        <Field
          label="Model"
          hint={
            <button
              onClick={() => setPromptMode("model")}
              style={{ background: "none", border: "none", color: "#b5552b", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0 }}
            >
              + add model
            </button>
          }
        >
          <select style={inputStyle} value={model} onChange={(e) => setModel(e.target.value)}>
            {modelNames.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Category"
          hint={
            <button
              onClick={() => setPromptMode("category")}
              style={{ background: "none", border: "none", color: "#b5552b", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0 }}
            >
              + add category
            </button>
          }
        >
          <select style={inputStyle} value={category} onChange={(e) => setCategory(e.target.value)}>
            {categoryNames.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid3">
        <Field label="Currency">
          <select style={inputStyle} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="AUD">AUD</option>
            <option value="USD">USD</option>
          </select>
        </Field>
        <Field label={`Supplier cost (${currency}, incl. GST)`}>
          <input
            style={inputStyle}
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            value={cost}
            onChange={(e) => handleCostChange(e.target.value)}
          />
        </Field>
        <Field label="Supplier">
          <select
            style={inputStyle}
            value={supplierNames.includes(supplier) ? supplier : "__custom__"}
            onChange={(e) => setSupplier(e.target.value === "__custom__" ? "" : e.target.value)}
          >
            <option value="__custom__">— select or type below —</option>
            {supplierNames.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <input
            style={{ ...inputStyle, marginTop: 6 }}
            type="text"
            placeholder="Or type supplier name manually"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
          />
        </Field>
      </div>
      {showAudPreview && (
        <div style={{ fontSize: 12.5, color: "#8a7a66", marginTop: -6, marginBottom: 13 }}>
          ≈ {fmtMoney(toAUD(parsedCostPreview, "USD", fx ? fx.usdAudRate : FALLBACK_USD_AUD_RATE), "AUD")} AUD at the current rate (1 USD = {(fx ? fx.usdAudRate : FALLBACK_USD_AUD_RATE).toFixed(4)} AUD)
        </div>
      )}

      <Field
        label={`Sell price (${currency}, incl. GST)`}
        hint="Defaults to a 50% margin on cost (sell = cost × 2). Edit any time — it'll recalculate automatically if you change the cost above."
      >
        <input
          style={inputStyle}
          type="number"
          step="0.01"
          min="0"
          placeholder="0.00"
          value={sellPrice}
          onChange={(e) => setSellPrice(e.target.value)}
        />
      </Field>
      {showSellAudPreview && (
        <div style={{ fontSize: 12.5, color: "#8a7a66", marginTop: -6, marginBottom: 13 }}>
          ≈ {fmtMoney(toAUD(parsedSellPreview, "USD", fx ? fx.usdAudRate : FALLBACK_USD_AUD_RATE), "AUD")} AUD at the current rate
        </div>
      )}

      <Field label="Product description">
        <textarea
          style={{ ...inputStyle, minHeight: 80, resize: "vertical" }}
          placeholder="Enter one feature per line — each line becomes a bullet point on the quote&#10;e.g.&#10;Full kitchen with induction cooktop&#10;80L fresh water tank&#10;Solar panel 400W"
          value={itemDescription}
          onChange={(e) => setItemDescription(e.target.value)}
        />
      </Field>

      <Field label="Notes (optional)">
        <textarea
          style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
          placeholder="Spec details, lead time, part number…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      {error && (
        <div
          style={{
            background: "#fbeae5",
            border: "1px solid #e6c9bf",
            color: "#a3442e",
            borderRadius: 8,
            padding: "9px 12px",
            fontSize: 13,
            marginBottom: 14,
          }}
        >
          {error}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
        <Btn variant="ghost" onClick={onCancel}>
          Cancel
        </Btn>
        <Btn variant="primary" onClick={handleSave}>
          {editing ? "Save changes" : "Add item"}
        </Btn>
      </div>
      {promptMode && (
        <PromptModal
          title={promptMode === "model" ? "Add a new model" : "Add a new category"}
          label={promptMode === "model" ? "Model name" : "Category name"}
          placeholder={promptMode === "model" ? "e.g. Trailblazer" : "e.g. Water Systems"}
          confirmLabel="Add"
          onCancel={() => setPromptMode(null)}
          onConfirm={(value) => {
            if (promptMode === "model") {
              onAddModel(value);
              setModel(value);
            } else {
              onAddCategory(value);
              setCategory(value);
            }
            setPromptMode(null);
          }}
        />
      )}
    </Modal>
  );
}

function ImportCSVModal({ models, categories, onImport, onCancel, onAddModel, onAddCategory, showToast }) {
  const [csvText, setCsvText] = useState("");
  const [preview, setPreview] = useState([]);
  const [errors, setErrors] = useState([]);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);
  
  // Debug: log whenever preview or errors change
  useEffect(() => {
    console.log("📋 ImportCSVModal preview updated:", preview.length, "errors:", errors.length);
  }, [preview, errors]);

  function parseCSV(text) {
    const lines = text.trim().split("\n");
    if (lines.length < 2) return { rows: [], errors: ["CSV must have header row and at least one data row"] };

    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const rows = [];
    const errs = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(",").map((v) => v.trim());
      if (values.length === 0 || values.every((v) => !v)) continue; // Skip empty lines

      const row = {};
      header.forEach((col, idx) => {
        row[col] = values[idx] || "";
      });

      // Validate required fields
      if (!row.number || !row.description) {
        errs.push(`Row ${i + 1}: Missing number or description`);
        continue;
      }

      const cost = parseFloat(row.cost_aud) || 0;
      if (cost <= 0) {
        errs.push(`Row ${i + 1}: Cost must be a positive number`);
        continue;
      }

      // Auto-add model and category if they don't exist
      if (row.model && !models.includes(row.model)) {
        onAddModel(row.model);
      }
      if (row.category && !categories.includes(row.category)) {
        onAddCategory(row.category);
      }

      rows.push({
        id: uid("item"),
        number: row.number,
        name: row.description,
        category: row.category || "Other",
        model: row.model || "",
        supplier: row.supplier || "",
        cost: cost,
        createdAt: todayISO(),
        updatedAt: todayISO(),
      });
    }

    return { rows, errors: errs };
  }

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    console.log("📁 File selected:", file?.name, "size:", file?.size);
    if (!file) {
      console.log("❌ No file selected");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result || "";
        console.log("📄 CSV text loaded, length:", text.length);
        console.log("📄 First 200 chars:", text.substring(0, 200));
        setCsvText(text);
        const { rows, errors: parseErrors } = parseCSV(text);
        console.log("✅ parseCSV returned:", { rows: rows.length, errors: parseErrors.length });
        console.log("📊 Parse errors:", parseErrors);
        setPreview(rows);
        setErrors(parseErrors);
      } catch (err) {
        console.error("❌ Error in handleFileSelect:", err);
        setErrors(["Error reading file: " + err.message]);
      }
    };
    reader.onerror = (err) => {
      console.error("❌ FileReader error:", err);
      setErrors(["Error reading file"]);
    };
    reader.readAsText(file);
  }

  async function handleImport() {
    console.log("🔘 IMPORT BUTTON CLICKED - handleImport called!");
    console.log("📊 Current state:", { previewLength: preview.length, errorsLength: errors.length, importing });
    setImporting(true);
    console.log("🔍 handleImport started, preview items:", preview.length);
    try {
      const savedItems = [];
      const failedItems = [];
      
      // Save each item to Supabase REST API
      for (const item of preview) {
        try {
          const savePayload = toSupabaseFormat(
            { ...item, id: item.id, number: item.number || item.id },
            "items"
          );

          console.log(`📝 Saving item ${item.number} to Supabase:`, savePayload);
          const result = await supabaseREST("POST", "items", savePayload);
          console.log(`✅ Successfully saved item ${item.number}:`, result);
          savedItems.push(item);
        } catch (itemErr) {
          console.error(`❌ Failed to save item ${item.number}:`, itemErr);
          failedItems.push({
            number: item.number,
            error: itemErr.message || String(itemErr),
          });
        }
      }
      
      console.log(`📊 Import summary: ${savedItems.length} saved, ${failedItems.length} failed`);
      
      if (failedItems.length > 0) {
        // Some items failed - show error and don't update local state
        const errorMsg = failedItems.map((f) => `${f.number}: ${f.error}`).join(", ");
        setErrors([...errors, `Failed to save ${failedItems.length} items: ${errorMsg}`]);
        showToast(`⚠️ Import failed: ${failedItems.length} items could not be saved`);
        console.error("Import failed items:", failedItems);
      } else if (savedItems.length > 0) {
        // All items saved successfully - now update local state
        console.log(`All ${savedItems.length} items saved to Supabase. Updating local state.`);
        onImport(savedItems);
        showToast(`✅ Successfully imported ${savedItems.length} items to Supabase`);
        
        // Reset file input so user can import again
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
          console.log("✅ File input cleared");
        }
        
        // Reset preview and errors
        setPreview([]);
        setErrors([]);
      }
    } catch (err) {
      console.error("Import error:", err);
      setErrors([...errors, `Import error: ${err.message}`]);
      showToast(`❌ Import failed: ${err.message}`);
    } finally {
      setImporting(false);
    }
  }

  return (
    <Modal title="Import Price Book CSV" onClose={onCancel}>
      <div style={{ marginBottom: 20 }}>
        <p style={{ marginBottom: 12, fontSize: 13, color: "#666" }}>
          Upload a CSV file with columns: <code style={{ background: "#f5f5f5", padding: "2px 6px" }}>number, description, category, model, supplier, cost_aud</code>
        </p>
        <button
          onClick={() => document.getElementById("price-book-import-input")?.click()}
          style={{
            padding: "10px 16px",
            cursor: "pointer",
            background: "#b5552b",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            fontWeight: 600,
            width: "100%",
            fontSize: 14,
          }}
        >
          📁 Choose CSV File
        </button>
        <input
          id="price-book-import-input"
          ref={fileInputRef}
          type="file"
          accept=".csv"
          onChange={handleFileSelect}
          disabled={importing}
          style={{ display: "none" }}
        />
      </div>

      {errors.length > 0 && (
        <div style={{ background: "#fee", padding: 12, borderRadius: 4, marginBottom: 16, borderLeft: "3px solid #c33" }}>
          <p style={{ margin: "0 0 8px 0", fontWeight: 600, color: "#c33" }}>Import errors:</p>
          {errors.map((err, i) => (
            <p key={i} style={{ margin: 4, fontSize: 12, color: "#c33" }}>
              • {err}
            </p>
          ))}
        </div>
      )}

      {preview.length > 0 && (
        <div style={{ background: "#f9f9f9", padding: 12, borderRadius: 4, marginBottom: 16, maxHeight: 300, overflow: "auto" }}>
          <p style={{ margin: "0 0 8px 0", fontWeight: 600 }}>Preview ({preview.length} items):</p>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #ddd" }}>
                <th style={{ padding: 4, textAlign: "left" }}>Number</th>
                <th style={{ padding: 4, textAlign: "left" }}>Description</th>
                <th style={{ padding: 4, textAlign: "left" }}>Category</th>
                <th style={{ padding: 4, textAlign: "left" }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {preview.slice(0, 10).map((item, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: 4 }}>{item.number}</td>
                  <td style={{ padding: 4 }}>{item.name}</td>
                  <td style={{ padding: 4 }}>{item.category}</td>
                  <td style={{ padding: 4 }}>${item.cost.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.length > 10 && <p style={{ marginTop: 8, fontSize: 12, color: "#666" }}>...and {preview.length - 10} more items</p>}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button 
          onClick={onCancel} 
          disabled={importing}
          style={{ padding: "10px 16px", cursor: "pointer" }}
        >
          Cancel
        </button>
        <button 
          onClick={handleImport}
          disabled={preview.length === 0 || errors.length > 0 || importing}
          style={{ padding: "10px 16px", cursor: "pointer", background: "#b5552b", color: "#fff", border: "none", borderRadius: 8, fontWeight: 600 }}
        >
          {importing ? "Importing..." : `Import ${preview.length} Items`}
        </button>
      </div>
    </Modal>
  );
}

/* ============================================================
   DOCS TAB (shared for Quotes + Purchase Orders)
   ============================================================ */

function DocsTab({ kind, db, update, showToast, nextNumber, pendingOpen, clearPendingOpen, openRecord }) {
  // Quick-add a new price book item from the quote/PO line editor.
  // Mirrors saveItem() in PriceBookTab. Returns the new item via callback so
  // the caller can immediately add it as a line.
  function addItemQuick(payload, onDone) {
    (async () => {
      try {
        const newItem = {
          createdAt: todayISO(),
          updatedAt: todayISO(),
          ...payload,
        };
        const createPayload = toSupabaseFormat(newItem, "items");
        delete createPayload.id; // items.id is a real uuid column — let Postgres generate it
        const result = await supabaseREST("POST", "items", createPayload);
        const savedRow = Array.isArray(result) ? result[0] : result;
        const savedItem = { ...newItem, ...fromSupabaseFormat(savedRow, "items"), id: savedRow.id };
        update((next) => {
          next.items.push(savedItem);
        });
        showToast("Item added to price book");
        if (onDone) onDone(savedItem);
      } catch (err) {
        showToast(`Error saving item: ${err.message}`);
        console.error("Quick add item error:", err);
      }
    })();
  }

  const isQuote = kind === "quote";
  
  // Move all hooks to TOP, before any conditional returns (React Hook Rules)
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [docModal, setDocModal] = useState(undefined);
  const [conversionWorkflow, setConversionWorkflow] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const isMobile = useIsMobile();
  const [poGenerationQuote, setPoGenerationQuote] = useState(null);
  const [renumberConfirm, setRenumberConfirm] = useState(false);
  const [renumbering, setRenumbering] = useState(false);
  const [linkQuotesConfirm, setLinkQuotesConfirm] = useState(false);
  const [linkingQuotes, setLinkingQuotes] = useState(false);
  const [linkPOsConfirm, setLinkPOsConfirm] = useState(false);
  const [linkingPOs, setLinkingPOs] = useState(false);

  // Cross-tab navigation: if another tab asked to open a specific quote/PO, do it.
  useEffect(() => {
    if (!pendingOpen || !db) return;
    const wantsQuote = pendingOpen.type === "quote" && isQuote;
    const wantsPO = pendingOpen.type === "po" && !isQuote;
    if (!wantsQuote && !wantsPO) return;
    const found = (isQuote ? db.quotes : db.pos || []).find((d) => d.id === pendingOpen.id);
    if (found) setDocModal(found);
    clearPendingOpen();
  }, [pendingOpen, db, isQuote]);
  
  if (!db || (!isQuote && !db.pos) || (isQuote && !db.quotes)) {
    return (
      <section>
        <h2 className="section-title">{isQuote ? "Quotes" : "Purchase Orders"}</h2>
        <p className="section-desc">Loading data...</p>
      </section>
    );
  }

  const collection = isQuote ? db.quotes : db.pos;

  const statusOptions = isQuote ? ["Draft", "Sent", "Accepted", "Declined"] : ["Draft", "Sent", "Received", "Cancelled"];

  let list = collection.slice();
  // Hide individual POs that have been absorbed into a consolidated group
  if (!isQuote) list = list.filter((d) => !d.consolidatedGroupId);
  if (search) {
    const s = search.toLowerCase();
    list = list.filter((d) => {
      const haystack = [
        d.party,
        d.number,
        d.model,
        d.contact,
        d.notes,
        d.status,
        d.customer,
        ...(d.lines || []).map((l) => l.desc),
        ...(d.lines || []).map((l) => l.lineNote),
      ]
        .filter(Boolean)
        .map(String)
        .join(" ")
        .toLowerCase();
      return haystack.includes(s);
    });
  }
  if (statusFilter) list = list.filter((d) => d.status === statusFilter);
  list.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "") || String(b.number).localeCompare(String(a.number)));

  function saveMilestones(doc, milestones) {
    (async () => {
      try {
        const table = isQuote ? "quotes" : "purchase_orders";
        const updatePayload = toSupabaseFormat({ paymentMilestones: milestones, updatedAt: todayISO() }, table);
        await supabaseRESTWithSchemaFallback("PATCH", `${table}?id=eq.${doc.id}`, updatePayload);
        update((next) => {
          const coll = isQuote ? next.quotes : next.pos;
          const target = coll.find((d) => d.id === doc.id);
          if (target) {
            target.paymentMilestones = milestones;
            target.updatedAt = todayISO();
          }

          // If this is a quote, sync milestones to the matching customer record.
          // Merge: keep existing invoices that have no matching milestone month,
          // and add/update from milestones. This preserves historical payment records
          // while adding future scheduled payments.
          if (isQuote && doc.party) {
            const customer = (next.customers || []).find(
              (c) => c.name && c.name.toLowerCase().trim() === doc.party.toLowerCase().trim()
            );
            if (customer) {
              const milestoneInvoices = milestones
                .filter(m => m.amount && m.due)
                .map(m => ({
                  amount: parseFloat(m.amount) || 0,
                  invoiceMonth: m.due.slice(0, 7), // YYYY-MM
                }));
              const milestoneMonths = new Set(milestoneInvoices.map(i => i.invoiceMonth));
              // Keep existing invoices whose month isn't covered by a milestone
              const existingKept = (customer.invoices || []).filter(
                inv => inv && inv.invoiceMonth && !milestoneMonths.has(inv.invoiceMonth)
              );
              const merged = [...existingKept, ...milestoneInvoices]
                .sort((a, b) => (a.invoiceMonth || "").localeCompare(b.invoiceMonth || ""));
              customer.invoices = merged;
              // Persist to Supabase
              (async () => {
                try {
                  await supabaseREST("PATCH", `customers?id=eq.${customer.id}`, { invoices: merged });
                } catch (e) {
                  console.error("Failed to sync milestones to customer:", e);
                }
              })();
            }
          }
        });
        showToast("Payment milestones saved");
      } catch (err) {
        showToast(`Error saving milestones: ${err.message}`);
        console.error("Save milestones error:", err);
      }
    })();
  }

  // One-time, explicit, irreversible action: reassign every existing quote a
  // new sequential QU-1000+ number, oldest quote (by createdAt) first.
  function renumberQuotes() {
    setRenumbering(true);
    (async () => {
      try {
        const sorted = [...db.quotes].sort((a, b) => {
          const da = a.createdAt || a.date || "";
          const db_ = b.createdAt || b.date || "";
          return da.localeCompare(db_);
        });
        const updates = sorted.map((q, i) => ({ id: q.id, oldNumber: q.number, newNumber: `QU-${1000 + i}` }));

        // Persist each new number to Supabase one at a time so a failure partway
        // through doesn't leave things in an unknown state without a clear log.
        for (const u of updates) {
          await supabaseREST("PATCH", `quotes?id=eq.${u.id}`, { number: u.newNumber });
        }

        update((next) => {
          updates.forEach((u) => {
            const target = next.quotes.find((q) => q.id === u.id);
            if (target) target.number = u.newNumber;
          });
          next.seq = next.seq || {};
          next.seq.quote = 1000 + updates.length;
        });

        showToast(`Renumbered ${updates.length} quote${updates.length === 1 ? "" : "s"} — starting at QU-1000`);
      } catch (err) {
        showToast(`Error renumbering quotes: ${err.message}`);
        console.error("Renumber quotes error:", err);
      } finally {
        setRenumbering(false);
        setRenumberConfirm(false);
      }
    })();
  }

  // Same idea, for purchase orders — reassign every existing PO a new
  // sequential PO-5001+ number, oldest PO (by createdAt) first.
  function renumberPOs() {
    setRenumbering(true);
    (async () => {
      try {
        const sorted = [...db.pos].sort((a, b) => {
          const da = a.createdAt || a.date || "";
          const db_ = b.createdAt || b.date || "";
          return da.localeCompare(db_);
        });
        const updates = sorted.map((p, i) => ({ id: p.id, oldNumber: p.number, newNumber: `PO-${5001 + i}` }));

        for (const u of updates) {
          await supabaseREST("PATCH", `purchase_orders?id=eq.${u.id}`, { number: u.newNumber });
        }

        update((next) => {
          updates.forEach((u) => {
            const target = next.pos.find((p) => p.id === u.id);
            if (target) target.number = u.newNumber;
          });
          next.seq = next.seq || {};
          next.seq.po = 5001 + updates.length;
        });

        showToast(`Renumbered ${updates.length} PO${updates.length === 1 ? "" : "s"} — starting at PO-5001`);
      } catch (err) {
        showToast(`Error renumbering POs: ${err.message}`);
        console.error("Renumber POs error:", err);
      } finally {
        setRenumbering(false);
        setRenumberConfirm(false);
      }
    })();
  }

  function linkQuotesToCustomers() {
    setLinkingQuotes(true);
    (async () => {
      try {
        const updates = [];
        for (const q of db.quotes) {
          if (!q.party) continue;
          const match = (db.customers || []).find(
            (c) => c.name && c.name.trim().toLowerCase() === q.party.trim().toLowerCase()
          );
          if (match && q.customerId !== match.id) {
            updates.push({ quoteId: q.id, customerId: match.id });
          }
        }

        for (const u of updates) {
          await supabaseREST("PATCH", `quotes?id=eq.${u.quoteId}`, { customer_id: u.customerId });
        }

        update((next) => {
          updates.forEach((u) => {
            const target = next.quotes.find((q) => q.id === u.quoteId);
            if (target) target.customerId = u.customerId;
          });
        });

        showToast(`Linked ${updates.length} quote${updates.length === 1 ? "" : "s"} to matching customer records`);
      } catch (err) {
        showToast(`Error linking quotes: ${err.message}`);
        console.error("Link quotes to customers error:", err);
      } finally {
        setLinkingQuotes(false);
        setLinkQuotesConfirm(false);
      }
    })();
  }

  function linkPOsToSuppliers() {
    setLinkingPOs(true);
    (async () => {
      try {
        const updates = [];
        for (const p of db.pos) {
          if (!p.party) continue;
          const match = (db.suppliers || []).find(
            (s) => s.name && s.name.trim().toLowerCase() === p.party.trim().toLowerCase()
          );
          if (match && p.supplierId !== match.id) {
            updates.push({ poId: p.id, supplierId: match.id });
          }
        }

        for (const u of updates) {
          await supabaseREST("PATCH", `purchase_orders?id=eq.${u.poId}`, { supplier_id: u.supplierId });
        }

        update((next) => {
          updates.forEach((u) => {
            const target = next.pos.find((p) => p.id === u.poId);
            if (target) target.supplierId = u.supplierId;
          });
        });

        showToast(`Linked ${updates.length} PO${updates.length === 1 ? "" : "s"} to matching supplier records`);
      } catch (err) {
        showToast(`Error linking POs: ${err.message}`);
        console.error("Link POs to suppliers error:", err);
      } finally {
        setLinkingPOs(false);
        setLinkPOsConfirm(false);
      }
    })();
  }

  function saveDoc(payload, editing) {
    // Resolve a proper ID-based link to a customer record by name match, so
    // linked-quotes lookups no longer depend solely on name-matching at
    // display time. Only applies to quotes — purchase orders link to suppliers.
    function resolveCustomerId(partyName) {
      if (!isQuote || !partyName || !db.customers) return null;
      const match = db.customers.find(
        (c) => c.name && c.name.trim().toLowerCase() === partyName.trim().toLowerCase()
      );
      return match ? match.id : null;
    }

    // Same idea for POs — resolve the linked supplier by name match.
    function resolveSupplierId(partyName) {
      if (isQuote || !partyName || !db.suppliers) return null;
      const match = db.suppliers.find(
        (s) => s.name && s.name.trim().toLowerCase() === partyName.trim().toLowerCase()
      );
      return match ? match.id : null;
    }

    // Save to Supabase first, then update local state
    (async () => {
      try {
        const table = isQuote ? "quotes" : "purchase_orders";
        
        if (editing) {
          // Update existing doc in Supabase
          const customerId = resolveCustomerId(payload.party);
          const supplierId = resolveSupplierId(payload.party);
          const updatePayload = toSupabaseFormat(
            {
              ...payload,
              updatedAt: todayISO(),
              ...(isQuote ? { customerId } : { supplierId }),
            },
            table
          );
          await supabaseRESTWithSchemaFallback("PATCH", `${table}?id=eq.${editing.id}`, updatePayload);
          // Then update local state
          update((next) => {
            const coll = isQuote ? next.quotes : next.pos;
            const target = coll.find((d) => d.id === editing.id);
            Object.assign(target, payload, {
              updatedAt: todayISO(),
              ...(isQuote ? { customerId } : { supplierId }),
            });
          });
        } else {
          // Create new doc in Supabase — let Postgres generate the real UUID
          // (id column is uuid type; a client-generated string like "q_xxxxx" is rejected).
          const number = nextNumber(isQuote ? "quote" : "po", db);
          const customerId = resolveCustomerId(payload.party);
          const supplierId = resolveSupplierId(payload.party);
          const newDocLocal = {
            number,
            status: payload.status || "Draft",
            createdAt: todayISO(),
            ...payload,
            ...(isQuote ? { customerId } : { supplierId }),
          };
          const createPayload = toSupabaseFormat(newDocLocal, table);
          delete createPayload.id;
          const result = await supabaseRESTWithSchemaFallback("POST", table, createPayload);
          const savedRow = Array.isArray(result) ? result[0] : result;
          const newDoc = { ...newDocLocal, ...fromSupabaseFormat(savedRow, table), id: savedRow.id };
          // Then update local state
          update((next) => {
            const coll = isQuote ? next.quotes : next.pos;
            coll.push(newDoc);
            
            // If this is a quote, auto-update the matching prospect's sales value
            if (isQuote && next.crm) {
              const prospect = next.crm.find((p) => p.name === payload.party);
              if (prospect && payload.total != null && payload.total > 0) {
                prospect.salesValue = payload.total;
                prospect.updatedAt = todayISO();
              }
            }
          });
          // Keep the modal open, now showing the real assigned number, instead of
          // closing immediately — otherwise the number is never actually seen.
          setDocModal(newDoc);
          showToast(`${isQuote ? "Quote" : "Purchase order"} created — ${newDoc.number}`);
          return;
        }
        setDocModal(undefined);
        showToast(editing ? "Changes saved" : `${isQuote ? "Quote" : "Purchase order"} created`);
      } catch (err) {
        showToast(`Error saving ${isQuote ? "quote" : "PO"}: ${err.message}`);
        console.error("Save doc error:", err);
      }
    })();
  }

  function deleteDoc(doc) {
    setPendingDelete(doc);
  }

  function handleGeneratePOs(quote) {
    setPoGenerationQuote(quote);
  }

  function consolidatePOs(primaryPO, memberPOs) {
    // Merge memberPOs into primaryPO creating a consolidated group
    // primaryPO becomes the "group leader" — its id is the group id
    // memberPOs get consolidatedGroupId = primaryPO.id and are hidden from list
    (async () => {
      try {
        const allPOs = [primaryPO, ...memberPOs];
        const totalValue = allPOs.reduce((s, po) => s + (po.total || 0), 0);
        
        // Merged lines from all POs
        const mergedLines = allPOs.flatMap(po =>
          (po.lines || []).map(line => ({
            ...line,
            desc: `[${po.number}${po.customer ? " — " + po.customer : ""}] ${line.desc || ""}`.trim(),
          }))
        );
        const mergedTotal = allPOs.reduce((s, po) => s + (po.total || 0), 0);
        const memberIds = memberPOs.map(p => p.id);

        // Update primaryPO: add merged lines + member ids
        const primaryUpdate = toSupabaseFormat({
          lines: mergedLines,
          total: mergedTotal,
          subtotal: mergedTotal,
          consolidatedMemberIds: memberIds,
          updatedAt: todayISO(),
        }, "purchase_orders");
        await supabaseRESTWithSchemaFallback("PATCH", `purchase_orders?id=eq.${primaryPO.id}`, primaryUpdate);

        // Update each member PO: set consolidatedGroupId so they hide from list
        for (const mpo of memberPOs) {
          const memberUpdate = toSupabaseFormat({
            consolidatedGroupId: primaryPO.id,
            updatedAt: todayISO(),
          }, "purchase_orders");
          await supabaseRESTWithSchemaFallback("PATCH", `purchase_orders?id=eq.${mpo.id}`, memberUpdate);
        }

        update((next) => {
          // Update primary PO
          const primary = next.pos.find(p => p.id === primaryPO.id);
          if (primary) {
            primary.lines = mergedLines;
            primary.total = mergedTotal;
            primary.subtotal = mergedTotal;
            primary.consolidatedMemberIds = memberIds;
          }
          // Update members
          memberPOs.forEach(mpo => {
            const mp = next.pos.find(p => p.id === mpo.id);
            if (mp) mp.consolidatedGroupId = primaryPO.id;
          });
        });

        showToast(`Consolidated ${allPOs.length} POs into ${primaryPO.number}`);
      } catch (err) {
        showToast(`Consolidation error: ${err.message}`);
        console.error("Consolidate POs error:", err);
      }
    })();
  }

  function reverseConsolidation(groupPO) {
    // Separate a consolidated PO back into independent POs
    (async () => {
      try {
        const memberIds = groupPO.consolidatedMemberIds || [];
        const memberPOs = (db.pos || []).filter(p => memberIds.includes(p.id));
        
        // Restore primary PO to original state (remove merged lines)
        // Extract primary's original lines by filtering out member lines
        // Member lines have "[PO#..." prefix, so we can identify them
        const primaryOriginalLines = (groupPO.lines || []).filter(line => {
          // Check if this line belongs to a member PO (has the [PO# prefix)
          const isMemberLine = memberPOs.some(mpo => 
            line.desc?.includes(`[${mpo.number}`)
          );
          return !isMemberLine;
        });

        const primaryTotal = primaryOriginalLines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);

        // Update primary PO: restore original lines, clear consolidation
        const primaryUpdate = toSupabaseFormat({
          lines: primaryOriginalLines,
          total: primaryTotal,
          subtotal: primaryTotal,
          consolidatedMemberIds: [],
          updatedAt: todayISO(),
        }, "purchase_orders");
        await supabaseRESTWithSchemaFallback("PATCH", `purchase_orders?id=eq.${groupPO.id}`, primaryUpdate);

        // Update each member PO: remove consolidatedGroupId
        for (const mpo of memberPOs) {
          const memberUpdate = toSupabaseFormat({
            consolidatedGroupId: null,
            updatedAt: todayISO(),
          }, "purchase_orders");
          await supabaseRESTWithSchemaFallback("PATCH", `purchase_orders?id=eq.${mpo.id}`, memberUpdate);
        }

        update((next) => {
          // Update primary PO
          const primary = next.pos.find(p => p.id === groupPO.id);
          if (primary) {
            primary.lines = primaryOriginalLines;
            primary.total = primaryTotal;
            primary.subtotal = primaryTotal;
            primary.consolidatedMemberIds = [];
          }
          // Update members
          memberPOs.forEach(mpo => {
            const mp = next.pos.find(p => p.id === mpo.id);
            if (mp) mp.consolidatedGroupId = null;
          });
        });

        showToast(`Reversed consolidation for PO ${groupPO.number}`);
      } catch (err) {
        showToast(`Reversal error: ${err.message}`);
        console.error("Reverse consolidation error:", err);
      }
    })();
  }

  function splitCustomsClearance(groupPO, customsAmount) {
    // Split customs clearance 50/50 across member POs
    (async () => {
      try {
        const allPOIds = [groupPO.id, ...(groupPO.consolidatedMemberIds || [])];
        const allPOs = (db.pos || []).filter(p => allPOIds.includes(p.id));
        if (allPOs.length === 0) { showToast("No POs to split"); return; }

        // Split 50/50 across all POs
        const splitAmount = Math.round((customsAmount / allPOs.length) * 100) / 100;
        
        // Update each PO's customsClearance with equal 50/50 split
        for (const po of allPOs) {
          await supabaseRESTWithSchemaFallback("PATCH", `purchase_orders?id=eq.${po.id}`,
            toSupabaseFormat({ customsClearance: splitAmount, updatedAt: todayISO() }, "purchase_orders")
          );
        }
        update((next) => {
          allPOs.forEach(po => {
            const p = next.pos.find(x => x.id === po.id);
            if (p) {
              p.customsClearance = splitAmount;
            }
          });
          const gp = next.pos.find(p => p.id === groupPO.id);
          if (gp) gp.customsClearance = customsAmount;
        });
        showToast(`Freight Forward Fee $${customsAmount.toLocaleString()} split 50/50 across ${allPOs.length} POs ($${splitAmount.toLocaleString()} each)`);
      } catch (err) {
        showToast(`Split error: ${err.message}`);
        console.error("Split customs error:", err);
      }
    })();
  }

  function createCustomsPO(parentPO) {
    // Create a dedicated Customs Clearance PO from the parent PO's customs amount
    (async () => {
      try {
        const poNumber = nextNumber("po", db);
        const amount = parentPO.customsClearance || 0;
        const newPO = {
          number: poNumber,
          status: "Draft",
          party: "Australian Border Force",
          customer: parentPO.customer || parentPO.party || "",
          model: parentPO.model || "",
          date: todayISO(),
          contact: "",
          notes: `Customs clearance for PO ${parentPO.number}`,
          discount: 0,
          lines: [{ desc: `Customs clearance — PO ${parentPO.number}`, qty: 1, price: amount, currency: "AUD", cost: amount }],
          subtotal: amount,
          gst: 0,
          total: amount,
          grossProfitPct: null,
          fxRateUsed: db.fx ? db.fx.usdAudRate : 1.55,
          quoteId: parentPO.quoteId || null,
          quoteNumber: parentPO.quoteNumber || "",
          customsClearance: 0,
          createdAt: todayISO(),
        };
        const createPayload = toSupabaseFormat(newPO, "purchase_orders");
        const result = await supabaseRESTWithSchemaFallback("POST", "purchase_orders", createPayload);
        const savedRow = Array.isArray(result) ? result[0] : result;
        const saved = { ...newPO, ...fromSupabaseFormat(savedRow, "purchase_orders"), id: savedRow.id };
        update((next) => { next.pos.push(saved); });
        showToast(`Customs PO ${poNumber} created`);
        // Open the new PO immediately
        if (openRecord) openRecord("po", saved.id);
      } catch (err) {
        showToast(`Error creating customs PO: ${err.message}`);
        console.error("Create customs PO error:", err);
      }
    })();
  }

  function createPOsForSuppliers(supplierMap) {
    // Create POs in Supabase first, then update local state
    console.log("🔍 createPOsForSuppliers called with suppliers:", Object.keys(supplierMap));
    (async () => {
      try {
        const createdPOs = [];
        // Create each PO in Supabase — let Postgres generate the real UUID
        for (const supplier of Object.values(supplierMap)) {
          console.log("📤 Creating PO for supplier:", supplier.name);
          const poNumber = nextNumber("po", db);
          const poTotal = supplier.lines.reduce((sum, line) => {
            const costInAud = line.currency === "USD" ? line.price * db.fx.usdAudRate : line.price;
            return sum + costInAud * line.qty;
          }, 0);

          const newPOPayload = {
            number: poNumber,
            status: "Draft",
            party: supplier.name,
            customer: poGenerationQuote.party,
            // Reference field: customer last name (extracted from quote party)
            model: poGenerationQuote.party ? poGenerationQuote.party.split(" ").pop() : "",
            date: todayISO(),
            contact: "",
            notes: `Generated from quote ${poGenerationQuote.number}`,
            discount: 0,
            lines: supplier.lines,
            subtotal: poTotal,
            gst: 0,
            total: poTotal,
            grossProfitPct: null,
            fxRateUsed: db.fx.usdAudRate,
            quoteId: poGenerationQuote.id,
            quoteNumber: poGenerationQuote.number,
            createdAt: todayISO(),
            ...(poGenerationQuote.eta && { eta: poGenerationQuote.eta }),  // Copy ETA from quote
          };
          
          const createPayload = toSupabaseFormat(newPOPayload, "purchase_orders");
          const result = await supabaseRESTWithSchemaFallback("POST", "purchase_orders", createPayload);
          const savedRow = Array.isArray(result) ? result[0] : result;
          const finalPO = { ...newPOPayload, ...fromSupabaseFormat(savedRow, "purchase_orders"), id: savedRow.id };
          console.log("✅ Created PO:", finalPO.number, "ID:", finalPO.id);
          createdPOs.push(finalPO);
        }
        
        console.log("📋 Total POs created:", createdPOs.length, createdPOs.map(p => p.number));
        // Then update local state using the SAME ids Supabase generated,
        // so the local record actually matches the database row.
        update((next) => {
          createdPOs.forEach((po) => {
            // Prevent duplicates: check if this PO already exists by id
            const exists = next.pos.some(p => p.id === po.id);
            if (!exists) {
              console.log("📌 Adding PO to local state:", po.number);
              next.pos.push(po);
            } else {
              console.log("⚠️ PO already exists in state:", po.number);
            }
          });
        });
        
        setPoGenerationQuote(null);
        showToast(`${Object.keys(supplierMap).length} PO(s) created`);
      } catch (err) {
        showToast(`Error creating POs: ${err.message}`);
        console.error("Create POs error:", err);
      }
    })();
  }

  function setStatus(doc, status) {
    // Validate ETA required for quotes when changing to Accepted
    if (isQuote && status === "Accepted" && !doc.eta) {
      showToast("ETA is required to accept a quote");
      return;
    }
    
    // Save to Supabase first, then update local state
    (async () => {
      try {
        const table = isQuote ? "quotes" : "purchase_orders";
        
        // Update status in Supabase
        await supabaseREST("PATCH", `${table}?id=eq.${doc.id}`, {
          status,
          updated_at: todayISO(),
        });
        
        // If quote accepted, also persist the linked customer's last-quote info,
        // and advance the linked prospect's sales-funnel stage to "Deposit" —
        // this was previously only updated in local state (customer part) or not
        // at all (funnel part), so it would silently disappear/never happen.
        let matchedCustomer = null;
        let matchedProspect = null;
        if (isQuote && status === "Accepted") {
          matchedCustomer = (db.customers || []).find((c) => c.name === doc.party);
          if (matchedCustomer) {
            await supabaseREST("PATCH", `customers?id=eq.${matchedCustomer.id}`, {
              last_quote_number: String(doc.number),
              last_quote_value: doc.total || 0,
            });
          }
          matchedProspect = (db.crm || []).find((p) => p.name === doc.party);
          if (matchedProspect) {
            await supabaseREST("PATCH", `crm_prospects?id=eq.${matchedProspect.id}`, {
              current_status: "deposit",
            });
          }
        }

        // Then update local state
        update((next) => {
          const coll = isQuote ? next.quotes : next.pos;
          const target = coll.find((d) => d.id === doc.id);
          target.status = status;
          
          // If quote accepted, auto-update customer record with quote info
          if (isQuote && status === "Accepted" && matchedCustomer) {
            const customer = next.customers?.find((c) => c.id === matchedCustomer.id);
            if (customer) {
              customer.lastQuoteNumber = String(doc.number);
              customer.lastQuoteValue = doc.total || 0;
            }
          }
          // Advance the linked prospect's funnel stage to Deposit
          if (isQuote && status === "Accepted" && matchedProspect) {
            const prospect = next.crm?.find((p) => p.id === matchedProspect.id);
            if (prospect) prospect.currentStatus = "deposit";
          }
        });
        
        setDocModal((v) => (v ? { ...v, status } : v));
        
        // If quote accepted, offer conversion workflow for the matched prospect
        if (isQuote && status === "Accepted" && matchedProspect) {
          setConversionWorkflow({ quoteId: doc.id, prospectId: matchedProspect.id, prospectName: matchedProspect.name });
        }
        
        showToast("Status updated");
      } catch (err) {
        showToast(`Error updating status: ${err.message}`);
        console.error("Set status error:", err);
      }
    })();
  }

  return (
    <section>
      <div className="toolbar-row">
        <div>
          <h2 className="section-title" style={{ marginTop: 8 }}>
            {isQuote ? "Customer Quotes" : "Purchase Orders"}
          </h2>
          <p className="section-desc">
            {isQuote
              ? "Build a quote from your price book, track its status, and keep every quote on file."
              : "Send price-book costs to suppliers as POs and keep a running record of every order."}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          {isQuote && (
            <>
              <Btn variant="ghost" onClick={() => setLinkQuotesConfirm(true)}>
                Link quotes to customers
              </Btn>
              <Btn variant="ghost" onClick={() => setRenumberConfirm(true)}>
                Renumber quotes
              </Btn>
            </>
          )}
          {!isQuote && (
            <>
              <Btn variant="ghost" onClick={() => setLinkPOsConfirm(true)}>
                Link POs to suppliers
              </Btn>
              <Btn variant="ghost" onClick={() => setRenumberConfirm(true)}>
                Renumber POs
              </Btn>
            </>
          )}
          <Btn variant="primary" onClick={() => setDocModal(null)}>
            + New {isQuote ? "quote" : "purchase order"}
          </Btn>
        </div>
      </div>

      {linkPOsConfirm && (
        <Modal onClose={() => (!linkingPOs ? setLinkPOsConfirm(false) : null)} width={440}>
          <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 12px", fontSize: 18 }}>
            Link existing POs to supplier records?
          </h3>
          <p style={{ fontSize: 13, color: "#6b5240", lineHeight: 1.5, margin: "0 0 18px" }}>
            This finds POs whose supplier name matches a supplier record exactly, and links them by ID —
            so they'll appear on that supplier's record reliably, even if the name is edited later. POs
            with no matching supplier name are left unchanged. Safe to run more than once.
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <Btn variant="ghost" onClick={() => setLinkPOsConfirm(false)} disabled={linkingPOs}>
              Cancel
            </Btn>
            <Btn variant="primary" onClick={linkPOsToSuppliers} disabled={linkingPOs}>
              {linkingPOs ? "Linking…" : "Yes, link matching POs"}
            </Btn>
          </div>
        </Modal>
      )}

      {linkQuotesConfirm && (
        <Modal onClose={() => (!linkingQuotes ? setLinkQuotesConfirm(false) : null)} width={440}>
          <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 12px", fontSize: 18 }}>
            Link existing quotes to customer records?
          </h3>
          <p style={{ fontSize: 13, color: "#6b5240", lineHeight: 1.5, margin: "0 0 18px" }}>
            This finds quotes whose customer name matches a customer record exactly, and links them by ID —
            so they'll appear on that customer's record reliably, even if the name is edited later. Quotes
            with no matching customer name (e.g. still a prospect) are left unchanged. Safe to run more than once.
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <Btn variant="ghost" onClick={() => setLinkQuotesConfirm(false)} disabled={linkingQuotes}>
              Cancel
            </Btn>
            <Btn variant="primary" onClick={linkQuotesToCustomers} disabled={linkingQuotes}>
              {linkingQuotes ? "Linking…" : "Yes, link matching quotes"}
            </Btn>
          </div>
        </Modal>
      )}

      {renumberConfirm && (
        <Modal onClose={() => (!renumbering ? setRenumberConfirm(false) : null)} width={440}>
          <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 12px", fontSize: 18 }}>
            Renumber all {isQuote ? "quotes" : "POs"}?
          </h3>
          <p style={{ fontSize: 13, color: "#6b5240", lineHeight: 1.5, margin: "0 0 10px" }}>
            This will replace the number on all {isQuote ? db.quotes.length : db.pos.length} existing {isQuote ? "quote" : "PO"}{(isQuote ? db.quotes.length : db.pos.length) === 1 ? "" : "s"} with a new sequential number starting at <strong>{isQuote ? "QU-1000" : "PO-5001"}</strong>, ordered oldest to newest by creation date.
          </p>
          <p style={{ fontSize: 13, color: "#a3442e", lineHeight: 1.5, margin: "0 0 18px", fontWeight: 600 }}>
            This cannot be undone. Existing {isQuote ? "quote" : "PO"} numbers will be permanently overwritten.
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <Btn variant="ghost" onClick={() => setRenumberConfirm(false)} disabled={renumbering}>
              Cancel
            </Btn>
            <Btn variant="danger" onClick={isQuote ? renumberQuotes : renumberPOs} disabled={renumbering}>
              {renumbering ? "Renumbering…" : `Yes, renumber all ${isQuote ? "quotes" : "POs"}`}
            </Btn>
          </div>
        </Modal>
      )}

      <Panel style={{ padding: "16px 20px" }}>
        <div className="grid2" style={{ marginBottom: 0 }}>
          <Field label="Search">
            <input
              style={inputStyle}
              type="text"
              placeholder={`Search ${isQuote ? "customer" : "supplier"}, number, notes, line items…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <Field label="Status">
            <select style={inputStyle} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Panel>

      {list.length === 0 ? (
        <Empty
          icon={isQuote ? "🧾" : "📦"}
          text={
            collection.length === 0
              ? `No ${isQuote ? "quotes" : "purchase orders"} yet. Create your first ${isQuote ? "customer quote" : "PO to a supplier"}.`
              : "No results match your filters."
          }
        />
      ) : !isQuote ? (
        // ---------------- PURCHASE ORDERS: tap/click a row to open, directly
        // editable — no separate "Open" button, no view-then-edit step. ----------------
        isMobile ? (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {list.map((d) => (
              <div
                key={d.id}
                onClick={() => setDocModal(d)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "13px 4px",
                  borderBottom: "1px solid #f0e8d9",
                  cursor: "pointer",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#4a3527" }}>
                    #{d.number} · {d.party}
                  </div>
                  <div style={{ fontSize: 12, color: "#8a7a66", marginTop: 2, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Badge tone={d.status.toLowerCase()}>{d.status}</Badge>
                    <span>{fmtMoney(d.total)}</span>
                    {d.eta && <span>ETA {fmtDate(d.eta)}</span>}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteDoc(d);
                    }}
                    title="Delete"
                    style={{ background: "none", border: "none", color: "#a3442e", cursor: "pointer", fontSize: 16, padding: 4 }}
                  >
                    ✕
                  </button>
                  <span style={{ color: "#b5552b", fontSize: 16 }}>›</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Panel style={{ padding: 0, overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>PO #</th>
                  <th>Supplier</th>
                  <th>Reference</th>
                  <th>Date</th>
                  <th>ETA</th>
                  <th className="num">Total (AUD)</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((d) => (
                  <tr key={d.id} onClick={() => setDocModal(d)} style={{ cursor: "pointer" }}>
                    <td>
                      <strong>{d.number}</strong>
                    </td>
                    <td>{d.party}</td>
                    <td>{d.model ? <span className="muted">{d.model}</span> : <span className="muted">—</span>}</td>
                    <td className="muted">{fmtDate(d.date)}</td>
                    <td className="muted">{d.eta ? fmtDate(d.eta) : <span className="muted">—</span>}</td>
                    <td className="num">{fmtMoney(d.total)}</td>
                    <td>
                      <Badge tone={d.status.toLowerCase()}>{d.status}</Badge>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteDoc(d);
                        }}
                        title="Delete"
                        style={{ background: "none", border: "none", color: "#a3442e", cursor: "pointer", fontSize: 16, padding: 4 }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )
      ) : isMobile ? (
        // ---------------- QUOTES (mobile): tappable card list ----------------
        <div style={{ display: "flex", flexDirection: "column" }}>
          {list.map((d) => (
            <div
              key={d.id}
              onClick={() => setDocModal(d)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "13px 4px",
                borderBottom: "1px solid #f0e8d9",
                cursor: "pointer",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#4a3527" }}>
                  #{d.number} · {d.party}
                </div>
                <div style={{ fontSize: 12, color: "#8a7a66", marginTop: 2, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Badge tone={d.status.toLowerCase()}>{d.status}</Badge>
                  {d.model && <Badge tone="model">{d.model}</Badge>}
                  <span>{fmtMoney(d.total)}</span>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteDoc(d);
                  }}
                  title="Delete"
                  style={{ background: "none", border: "none", color: "#a3442e", cursor: "pointer", fontSize: 16, padding: 4 }}
                >
                  ✕
                </button>
                <span style={{ color: "#b5552b", fontSize: 16 }}>›</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        // ---------------- QUOTES (desktop): whole row opens the quote; no separate Open button ----------------
        <Panel style={{ padding: 0, overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Quote #</th>
                <th>Customer</th>
                <th>Model</th>
                <th>Date</th>
                <th className="num">Total (AUD)</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id} onClick={() => setDocModal(d)} style={{ cursor: "pointer" }}>
                  <td>
                    <strong>{d.number}</strong>
                  </td>
                  <td>{d.party}</td>
                  <td>
                    {d.model ? <Badge tone="model">{d.model}</Badge> : <span className="muted">—</span>}
                  </td>
                  <td className="muted">{fmtDate(d.date)}</td>
                  <td className="num">{fmtMoney(d.total)}</td>
                  <td>
                    <Badge tone={d.status.toLowerCase()}>{d.status}</Badge>
                    {!isQuote && d.consolidatedMemberIds?.length > 0 && (
                      <span style={{ marginLeft: 6, fontSize: 10, background: "#d4a574", color: "#fff", borderRadius: 3, padding: "1px 5px", fontWeight: 600 }}>
                        ⊕ {d.consolidatedMemberIds.length + 1} POs
                      </span>
                    )}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteDoc(d);
                      }}
                      title="Delete"
                      style={{ background: "none", border: "none", color: "#a3442e", cursor: "pointer", fontSize: 16, padding: 4 }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {docModal !== undefined && (
        <DocModal
          kind={kind}
          editing={docModal}
          db={db}
          items={db.items}
          models={db.models}
          categories={db.categories}
          fx={db.fx}
          statusOptions={statusOptions}
          onCancel={() => setDocModal(undefined)}
          onSave={saveDoc}
          onSaveMilestones={saveMilestones}
          onAddItem={addItemQuick}
          onAddModel={(name) => update((next) => { if (!next.models.includes(name)) next.models.push(name); })}
          onAddCategory={(name) => update((next) => { if (!next.categories.includes(name)) next.categories.push(name); })}
          onStatusChange={(status) => setStatus(docModal, status)}
          onDelete={(doc) => {
            setDocModal(undefined);
            setPendingDelete(doc);
          }}
          onGeneratePOs={isQuote ? handleGeneratePOs : null}
          onCreateCustomsPO={!isQuote ? createCustomsPO : null}
          onConsolidatePOs={!isQuote ? consolidatePOs : null}
          onReverseConsolidation={!isQuote ? reverseConsolidation : null}
          onSplitCustoms={!isQuote ? splitCustomsClearance : null}
          openRecord={openRecord}
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title={`Delete ${isQuote ? "quote" : "purchase order"}?`}
          message={`Delete ${pendingDelete.number}? This cannot be undone.`}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            try {
              // Delete from Supabase first
              const table = isQuote ? "quotes" : "purchase_orders";
              console.log(`🗑️ Deleting ${table} ${pendingDelete.id} from Supabase`);
              await supabaseREST("DELETE", table, null, `id=eq.${pendingDelete.id}`);
              console.log(`✅ Successfully deleted ${table} ${pendingDelete.id} from Supabase`);
              
              // Then update local state
              update((next) => {
                if (isQuote) next.quotes = next.quotes.filter((d) => d.id !== pendingDelete.id);
                else next.pos = next.pos.filter((d) => d.id !== pendingDelete.id);
              });
              showToast(`${isQuote ? "Quote" : "Purchase order"} deleted`);
            } catch (err) {
              console.error("Delete error:", err);
              showToast(`❌ Failed to delete: ${err.message}`);
            } finally {
              setPendingDelete(null);
            }
          }}
        />
      )}

      {poGenerationQuote && (
        <POGenerationModal
          quote={poGenerationQuote}
          items={db.items}
          suppliers={db.suppliers}
          onCancel={() => setPoGenerationQuote(null)}
          onGenerate={createPOsForSuppliers}
        />
      )}

      {conversionWorkflow && (
        <Modal onClose={() => setConversionWorkflow(null)}>
          <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 16px", fontSize: 19 }}>
            ✓ Finalize Sale: Convert Prospect to Customer
          </h3>
          <p style={{ color: "#6b5240", fontSize: 13, marginBottom: 14 }}>
            Quote accepted for <strong>{conversionWorkflow.prospectName}</strong>. Complete the sale by converting this prospect to a customer record.
          </p>

          <div style={{ background: "#f9f7f2", border: "1px solid #d3c9b8", borderRadius: 8, padding: 14, marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "#6b5240", marginBottom: 12 }}>
              <strong>What happens next:</strong>
            </div>
            <ul style={{ fontSize: 12, color: "#8a7a66", margin: 0, paddingLeft: 20 }}>
              <li>✓ Create customer record from prospect data</li>
              <li>✓ Remove prospect from pipeline</li>
              <li>✓ Track sales value from quote: <strong>{fmtMoney(db.quotes.find((q) => q.id === conversionWorkflow.quoteId)?.total || 0, "AUD")}</strong></li>
              <li>✓ You can still generate purchase orders separately</li>
            </ul>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <Btn variant="ghost" onClick={() => setConversionWorkflow(null)}>
              Cancel
            </Btn>
            <Btn variant="primary" onClick={() => {
              const prospect = db.crm.find((p) => p.id === conversionWorkflow.prospectId);
              if (prospect) {
                update((next) => {
                  // Create customer
                  next.customers.push({
                    id: uid("cus"),
                    name: prospect.name,
                    email: prospect.email || "",
                    phone: prospect.phone || "",
                    address: { street: "", suburb: "", state: "QLD", postcode: "" },
                    product: prospect.enquiryProduct || "",
                    notes: `Converted from prospect. Sales value: ${fmtMoney(prospect.salesValue || 0, "AUD")}`,
                    createdAt: todayISO(),
                  });
                  // Remove prospect
                  const idx = next.crm.findIndex((p) => p.id === conversionWorkflow.prospectId);
                  if (idx >= 0) next.crm.splice(idx, 1);
                });
                showToast(`${conversionWorkflow.prospectName} converted to customer`);
              }
              setConversionWorkflow(null);
            }}>
              Convert to Customer
            </Btn>
          </div>
        </Modal>
      )}
    </section>
  );
}

function DocModal({ kind, editing, db, items, models, categories, fx, statusOptions, onCancel, onSave, onSaveMilestones, onAddItem, onAddModel, onAddCategory, onStatusChange, onDelete, onGeneratePOs, onCreateCustomsPO, onConsolidatePOs, onReverseConsolidation, onSplitCustoms, openRecord }) {
  const isQuote = kind === "quote";
  const isMobile = useIsMobile();
  const rate = fx ? fx.usdAudRate : FALLBACK_USD_AUD_RATE;
  const isNew = editing === null;
  // POs now open directly editable, same as quotes and prospects — no separate
  // view-then-edit step. (viewOnly kept as a constant false rather than removing
  // every reference outright, to minimize the risk of missing a spot.)
  const viewOnly = false;

  const [party, setParty] = useState(editing ? editing.party : "");
  const [partyAutocomplete, setPartyAutocomplete] = useState(false);
  const [customer, setCustomer] = useState(editing && !isQuote ? editing.customer || "" : "");
  const [customerAutocomplete, setCustomerAutocomplete] = useState(false);
  const [model, setModel] = useState(editing ? editing.model || "" : "");
  const [date, setDate] = useState(editing ? editing.date : todayISO());
  const [contact, setContact] = useState(editing ? editing.contact || "" : "");
  const [notes, setNotes] = useState(editing ? editing.notes || "" : "");
  const [supplierNote, setSupplierNote] = useState(editing ? editing.supplierNote || "" : "");
  const [discount, setDiscount] = useState(editing ? String(editing.discount || 0) : "0");
  const [lines, setLines] = useState(
    editing && editing.lines
      ? JSON.parse(JSON.stringify(editing.lines)).map((l) => ({ currency: "AUD", ...l }))
      : []
  );
  const [status, setStatusLocal] = useState(editing ? editing.status : "Draft");
  const [pickerValue, setPickerValue] = useState("");
  const [showQuickAddItem, setShowQuickAddItem] = useState(false);
  const [error, setError] = useState("");
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showConsolidateModal, setShowConsolidateModal] = useState(false);
  const [consolidateSelected, setConsolidateSelected] = useState([]);
  const [showDetailedConsolidatedView, setShowDetailedConsolidatedView] = useState(false);
  const [consolidatedTab, setConsolidatedTab] = useState("details");
  const [previewPoId, setPreviewPoId] = useState(editing?.id || null);
  const [showProfitSection, setShowProfitSection] = useState(false);
  const [paymentMilestones, setPaymentMilestones] = useState(
    editing?.paymentMilestones ? editing.paymentMilestones : []
  );
  const [customsClearance, setCustomsClearance] = useState(
    !isQuote && (editing?.customsClearance !== undefined && editing.customsClearance !== null) ? editing.customsClearance : 0
  );
  const [consolidatedCustoms, setConsolidatedCustoms] = useState(customsClearance);
  const [attachments, setAttachments] = useState(
    editing?.attachments ? editing.attachments : []
  );
  const [eta, setEta] = useState(
    editing?.eta ? editing.eta : ""
  );

  const sortedItems = items.slice().sort((a, b) => (a.model || "").localeCompare(b.model || "") || (a.name || "").localeCompare(b.name || ""));

  // Every line total and the cost-side total are converted to AUD, regardless of source currency.
  // Prices are entered GST-inclusive, so these AUD figures are GST-inclusive too — no GST is added on top.
  function lineAudTotal(li) {
    const qty = Number(li.qty) || 0;
    const price = Number(li.price) || 0;
    return qty * toAUD(price, li.currency || "AUD", rate);
  }
  function lineAudCost(li) {
    const qty = Number(li.qty) || 0;
    const lineCurrency = li.currency || "AUD";
    
    // First priority: use the line's explicit cost field if provided
    if (li.cost != null && li.cost > 0) {
      return qty * toAUD(li.cost, lineCurrency, rate);
    }
    
    // Second priority: use the linked price-book item's cost
    // Manually-added blank lines with no itemId have no known cost and are excluded from the GP% calc.
    if (li.itemId) {
      const sourceItem = items.find((i) => i.id === li.itemId);
      if (sourceItem) return qty * toAUD(sourceItem.cost, sourceItem.currency || "AUD", rate);
    }
    return null;
  }

  const subtotal = lines.reduce((s, li) => s + lineAudTotal(li), 0);
  const discountNum = parseFloat(discount) || 0;
  const total = Math.max(subtotal - discountNum, 0);

  // Gross profit %: (AUD sell total - AUD cost total) / AUD sell total, using only lines with a known cost.
  const costEntries = lines.map(lineAudCost);
  const knownCostTotal = costEntries.reduce((s, c) => s + (c || 0), 0);
  const sellTotalForKnownCostLines = lines.reduce((s, li, idx) => s + (costEntries[idx] != null ? lineAudTotal(li) : 0), 0);
  const hasCostData = costEntries.some((c) => c != null);
  const grossProfitPct = hasCostData && sellTotalForKnownCostLines > 0 ? ((sellTotalForKnownCostLines - knownCostTotal) / sellTotalForKnownCostLines) * 100 : null;
  const grossProfitAmount = hasCostData ? sellTotalForKnownCostLines - knownCostTotal : null;

  function updateLine(idx, field, value) {
    setLines((prev) => {
      const next = prev.slice();
      if (field === "currency") {
        // Convert both price AND cost across currencies to maintain accuracy
        // e.g. USD 100 price + USD 50 cost -> AUD 141 price + AUD 70.50 cost
        const li = next[idx];
        const oldCurrency = li.currency || "AUD";
        const newCurrency = value;
        let newPrice = Number(li.price) || 0;
        let newCost = Number(li.cost) || 0;
        
        if (oldCurrency !== newCurrency) {
          if (oldCurrency === "USD" && newCurrency === "AUD") {
            // Converting USD to AUD: multiply by exchange rate
            newPrice = toAUD(newPrice, "USD", rate);
            newCost = toAUD(newCost, "USD", rate);
          } else if (oldCurrency === "AUD" && newCurrency === "USD") {
            // Converting AUD to USD: divide by exchange rate
            newPrice = rate ? newPrice / rate : newPrice;
            newCost = rate ? newCost / rate : newCost;
          }
          newPrice = Math.round(newPrice * 100) / 100;
          newCost = Math.round(newCost * 100) / 100;
        }
        next[idx] = { ...li, currency: newCurrency, price: newPrice, cost: newCost };
      } else if (field === "desc" || field === "lineNote") {
        next[idx] = { ...next[idx], [field]: value };
      } else {
        next[idx] = { ...next[idx], [field]: parseFloat(value) || 0 };
      }
      return next;
    });
  }
  function removeLine(idx) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }
  function addFromPicker() {
    if (!pickerValue) {
      setError("Please select an item from the dropdown first.");
      return;
    }
    const item = items.find((i) => i.id === pickerValue);
    if (!item) {
      setError("Selected item could not be found — it may have been deleted.");
      return;
    }
    setError("");
    const defaultPrice = isQuote ? (item.sellPrice != null ? item.sellPrice : calcSellPrice(item.cost)) : item.cost;
    setLines((prev) => [
      ...prev,
      { desc: `${item.model} — ${item.name}`, qty: 1, price: defaultPrice, currency: item.currency || "AUD", itemId: item.id, cost: 0, lineNote: item.itemDescription || "" },
    ]);
    setPickerValue("");
  }
  function addBlankLine() {
    setLines((prev) => [...prev, { desc: "", qty: 1, price: 0, currency: "AUD", cost: 0, lineNote: "" }]);
  }
  function handleQuickAddItem(payload) {
    onAddItem(payload, (newItem) => {
      const defaultPrice = isQuote ? (newItem.sellPrice != null ? newItem.sellPrice : calcSellPrice(newItem.cost)) : newItem.cost;
      setLines((prev) => [
        ...prev,
        { desc: `${newItem.model} — ${newItem.name}`, qty: 1, price: defaultPrice, currency: newItem.currency || "AUD", itemId: newItem.id, cost: 0, lineNote: newItem.itemDescription || "" },
      ]);
      setShowQuickAddItem(false);
    });
  }

  async function savePONotes(poId, newNotes) {
    // Save notes for a specific PO (used for member POs in consolidated view)
    try {
      const update = toSupabaseFormat({ notes: newNotes, updatedAt: todayISO() }, "purchase_orders");
      await supabaseRESTWithSchemaFallback("PATCH", `purchase_orders?id=eq.${poId}`, update);
      console.log(`✅ Saved notes for PO ${poId}`);
    } catch (err) {
      console.error("Error saving PO notes:", err);
    }
  }

  async function savePOSupplierNote(poId, newSupplierNote) {
    // Save supplier note for a specific PO
    console.log(`💾 Saving supplier note for PO ${poId}:`, newSupplierNote);
    try {
      const update = toSupabaseFormat({ supplierNote: newSupplierNote, updatedAt: todayISO() }, "purchase_orders");
      console.log("📤 Supabase update object:", update);
      await supabaseRESTWithSchemaFallback("PATCH", `purchase_orders?id=eq.${poId}`, update);
      console.log(`✅ Saved supplier note for PO ${poId}`);
    } catch (err) {
      console.error("Error saving PO supplier note:", err);
    }
  }

  function handleSave() {
    const trimmedParty = party.trim();
    if (!trimmedParty) {
      setError(`Please enter a ${isQuote ? "customer" : "supplier"} name.`);
      return;
    }
    if (lines.length === 0) {
      setError("Please add at least one line item.");
      return;
    }
    onSave(
      {
        party: trimmedParty,
        model,
        date,
        contact: contact.trim(),
        notes: notes.trim(),
        supplierNote: supplierNote.trim(),
        discount: discountNum,
        lines,
        subtotal,
        gst: 0,
        total,
        grossProfitPct,
        fxRateUsed: rate,
        status,
        attachments,
        ...(paymentMilestones.length > 0 && { paymentMilestones }),
        ...(!isQuote && { customsClearance }),  // Always include for POs (allows setting to 0)
        ...(!isQuote && customer && { customer }),
        eta,  // Always include ETA for both quotes and POs (persist to Supabase)
      },
      editing
    );
  }

  function handleStatusChange(newStatus) {
    setStatusLocal(newStatus);
    if (!isNew && onStatusChange) onStatusChange(newStatus);
  }

  // Resolve a name typed into party/customer to a linkable record, so we can
  // offer a "View" link. Checks prospects first, then customers, then suppliers.
  function resolveContactLink(name) {
    if (!name || !db) return null;
    const n = name.trim().toLowerCase();
    if (!n) return null;
    const prospect = (db.crm || []).find((p) => p.name.toLowerCase() === n);
    if (prospect) return { type: "prospect", id: prospect.id };
    const customer = (db.customers || []).find((c) => c.name.toLowerCase() === n);
    if (customer) return { type: "customer", id: customer.id };
    const supplier = (db.suppliers || []).find((s) => s.name.toLowerCase() === n);
    if (supplier) return { type: "supplier", id: supplier.id };
    return null;
  }

  const printRef = useRef(null);

  return (
    <Modal width={1000} onClose={onCancel}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <h3
          style={{
            fontFamily: "Georgia,serif",
            color: "#4a3527",
            margin: 0,
            fontSize: isMobile ? 15 : 19,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
        >
          {isNew ? (isQuote ? "New customer quote" : "New purchase order") : (isQuote ? "Customer Quote" : "Purchase Order")}
        </h3>
        {!isNew && (
          <Field label="" >
            <select
              style={{ ...inputStyle, width: 160 }}
              value={status}
              onChange={(e) => handleStatusChange(e.target.value)}
            >
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <div className="doc-split-grid">
        {/* ---------------- EDIT SIDE ---------------- */}
        <fieldset disabled={viewOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <Panel>
            <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 14px", fontSize: 16 }}>
              {isQuote ? "Customer" : "Supplier"} details
            </h3>
            <Field label={`${isQuote ? "Customer" : "Supplier"} name`}>
              <div style={{ position: "relative" }}>
                <input
                  style={inputStyle}
                  type="text"
                  placeholder={isQuote ? "e.g. John Smith" : "e.g. Brisbane Composites Pty Ltd"}
                  value={party}
                  onChange={(e) => setParty(e.target.value)}
                  onFocus={() => setPartyAutocomplete(true)}
                  onBlur={() => setTimeout(() => setPartyAutocomplete(false), 200)}
                />
                {partyAutocomplete && party.length > 0 && (
                  <div style={{
                    position: "absolute",
                    top: "100%",
                    left: 0,
                    right: 0,
                    background: "#fff",
                    border: "1px solid #d3c9b8",
                    borderTop: "none",
                    borderRadius: "0 0 4px 4px",
                    maxHeight: 200,
                    overflowY: "auto",
                    zIndex: 1000,
                  }}>
                    {isQuote && (
                      <>
                        {(db.crm || [])
                          .filter(p => p.name.toLowerCase().includes(party.toLowerCase()))
                          .map(p => (
                            <div
                              key={p.id}
                              onClick={() => { setParty(p.name); setContact(p.email || p.phone || ""); setPartyAutocomplete(false); }}
                              style={{
                                padding: "8px 12px",
                                borderBottom: "1px solid #e3d8c6",
                                cursor: "pointer",
                                fontSize: 13,
                                color: "#4a3527",
                              }}
                              onMouseOver={(e) => e.currentTarget.style.background = "#f9f7f2"}
                              onMouseOut={(e) => e.currentTarget.style.background = "transparent"}
                            >
                              <div style={{ fontWeight: 600 }}>{p.name}</div>
                              {p.email && <div style={{ fontSize: 11, color: "#8a7a66" }}>{p.email}</div>}
                            </div>
                          ))}
                        {(db.customers || [])
                          .filter(c => c.name.toLowerCase().includes(party.toLowerCase()))
                          .map(c => (
                            <div
                              key={c.id}
                              onClick={() => { setParty(c.name); setContact(c.email || c.phone || ""); setPartyAutocomplete(false); }}
                              style={{
                                padding: "8px 12px",
                                borderBottom: "1px solid #e3d8c6",
                                cursor: "pointer",
                                fontSize: 13,
                                color: "#4a3527",
                              }}
                              onMouseOver={(e) => e.currentTarget.style.background = "#f9f7f2"}
                              onMouseOut={(e) => e.currentTarget.style.background = "transparent"}
                            >
                              <div style={{ fontWeight: 600 }}>{c.name}</div>
                              {c.email && <div style={{ fontSize: 11, color: "#8a7a66" }}>{c.email}</div>}
                            </div>
                          ))}
                      </>
                    )}
                    {!isQuote && (
                      (db.suppliers || [])
                        .filter(s => s.name.toLowerCase().includes(party.toLowerCase()))
                        .map(s => (
                          <div
                            key={s.id}
                            onClick={() => {
                              setParty(s.name);
                              setContact(s.email || s.phone || "");
                              setPartyAutocomplete(false);
                            }}
                            style={{
                              padding: "8px 12px",
                              borderBottom: "1px solid #e3d8c6",
                              cursor: "pointer",
                              fontSize: 13,
                              color: "#4a3527",
                            }}
                            onMouseOver={(e) => e.currentTarget.style.background = "#f9f7f2"}
                            onMouseOut={(e) => e.currentTarget.style.background = "transparent"}
                          >
                            <div style={{ fontWeight: 600 }}>{s.name}</div>
                            {s.email && <div style={{ fontSize: 11, color: "#8a7a66" }}>{s.email}</div>}
                          </div>
                        ))
                    )}
                  </div>
                )}
              </div>
            </Field>
            {openRecord && resolveContactLink(party) && (
              <div style={{ margin: "-8px 0 12px" }}>
                <Btn
                  variant="text"
                  size="sm"
                  onClick={() => {
                    const link = resolveContactLink(party);
                    if (link) openRecord(link.type, link.id);
                  }}
                >
                  View {resolveContactLink(party).type === "prospect" ? "prospect" : resolveContactLink(party).type === "customer" ? "customer" : "supplier"} record →
                </Btn>
              </div>
            )}
            {!isQuote && (
              <Field label="Customer (optional)">
                <div style={{ position: "relative" }}>
                  <input
                    style={inputStyle}
                    type="text"
                    placeholder="Search and select a customer"
                    value={customer}
                    onChange={(e) => setCustomer(e.target.value)}
                    onFocus={() => setCustomerAutocomplete(true)}
                    onBlur={() => setTimeout(() => setCustomerAutocomplete(false), 200)}
                  />
                  {customerAutocomplete && customer.length > 0 && (
                    <div style={{
                      position: "absolute",
                      top: "100%",
                      left: 0,
                      right: 0,
                      background: "#fff",
                      border: "1px solid #d3c9b8",
                      borderTop: "none",
                      borderRadius: "0 0 4px 4px",
                      maxHeight: 200,
                      overflowY: "auto",
                      zIndex: 1000,
                    }}>
                      {(db.customers || [])
                        .filter(c => c.name.toLowerCase().includes(customer.toLowerCase()))
                        .map(c => (
                          <div
                            key={c.id}
                            onClick={() => {
                              setCustomer(c.name);
                              setCustomerAutocomplete(false);
                            }}
                            style={{
                              padding: "8px 12px",
                              borderBottom: "1px solid #e3d8c6",
                              cursor: "pointer",
                              fontSize: 13,
                              color: "#4a3527",
                            }}
                            onMouseOver={(e) => e.currentTarget.style.background = "#f9f7f2"}
                            onMouseOut={(e) => e.currentTarget.style.background = "transparent"}
                          >
                            <div style={{ fontWeight: 600 }}>{c.name}</div>
                            {c.email && <div style={{ fontSize: 11, color: "#8a7a66" }}>{c.email}</div>}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              </Field>
            )}
            {!isQuote && openRecord && resolveContactLink(customer) && (
              <div style={{ margin: "-8px 0 12px" }}>
                <Btn
                  variant="text"
                  size="sm"
                  onClick={() => {
                    const link = resolveContactLink(customer);
                    if (link) openRecord(link.type, link.id);
                  }}
                >
                  View customer record →
                </Btn>
              </div>
            )}
            <div className="grid2">
              <Field label={isQuote ? "Camper model" : "Reference / job"}>
                {isQuote ? (
                  <select style={inputStyle} value={model} onChange={(e) => setModel(e.target.value)}>
                    <option value="">— select —</option>
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    style={inputStyle}
                    type="text"
                    placeholder="e.g. Stock build — June"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Date">
                <input style={inputStyle} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
            </div>
            <Field label={isQuote ? "Contact (email/phone)" : "Supplier contact"}>
              <input style={inputStyle} type="text" placeholder="Optional" value={contact} onChange={(e) => setContact(e.target.value)} />
            </Field>
            <Field label={isQuote ? "ETA (Estimated Delivery)" : "ETA (Estimated Time of Arrival)"}>
              <input 
                style={inputStyle} 
                type="date" 
                value={eta} 
                onChange={(e) => setEta(e.target.value)}
              />
              <p style={{ fontSize: 11, color: "#8a7a66", margin: "4px 0 0" }}>
                {isQuote ? "Will be copied to POs created from this quote" : "Required for all purchase orders"}
              </p>
            </Field>
          </Panel>

          <Panel>
            <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 14px", fontSize: 16 }}>
              Add from price book
            </h3>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <select style={{ ...inputStyle, flex: 1 }} value={pickerValue} onChange={(e) => setPickerValue(e.target.value)}>
                <option value="">— choose an item —</option>
                {sortedItems
                  .filter((i) => {
                    // For quotes: show all items
                    if (isQuote) return true;
                    // For POs: show items from selected supplier, or items with no supplier assigned
                    if (!party) return true;  // No supplier selected, show all
                    return !i.supplier || i.supplier === party;  // Show items with matching supplier OR no supplier
                  })
                  .map((i) => {
                    const displayPrice = isQuote ? (i.sellPrice != null ? i.sellPrice : calcSellPrice(i.cost)) : i.cost;
                    return (
                      <option key={i.id} value={i.id}>
                        {i.model} · {i.name} — {fmtMoney(displayPrice, i.currency || "AUD")}
                        {(i.currency || "AUD") === "USD" ? " (USD)" : ""}
                      </option>
                    );
                  })}
              </select>
              <Btn variant="ghost" size="sm" onClick={addFromPicker}>
                Add
              </Btn>
            </div>
            <Btn variant="ghost" size="sm" onClick={addBlankLine}>
              + Add blank line
            </Btn>
            {onAddItem && (
              <Btn variant="ghost" size="sm" onClick={() => setShowQuickAddItem(true)} style={{ marginLeft: 8 }}>
                + New price book item
              </Btn>
            )}
          </Panel>

          <Panel>
            <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 14px", fontSize: 16 }}>
              Line items
            </h3>
            {lines.length === 0 ? (
              <p className="muted" style={{ fontSize: 13, margin: "6px 0 14px" }}>
                No line items yet — add from your price book or add a blank line.
              </p>
            ) : (
              lines.map((li, idx) => {
                const lineCurrency = li.currency || "AUD";
                const nativeTotal = (Number(li.qty) || 0) * (Number(li.price) || 0);
                return (
                  <React.Fragment key={idx}>
                  <div className="line-item-row">
                    <input
                      style={inputStyle}
                      type="text"
                      placeholder="Description"
                      value={li.desc}
                      onChange={(e) => updateLine(idx, "desc", e.target.value)}
                    />
                    <input
                      style={inputStyle}
                      type="number"
                      min="0"
                      step="1"
                      placeholder="Qty"
                      value={li.qty}
                      onChange={(e) => updateLine(idx, "qty", e.target.value)}
                    />
                    <select style={inputStyle} value={lineCurrency} onChange={(e) => updateLine(idx, "currency", e.target.value)}>
                      <option value="AUD">AUD</option>
                      <option value="USD">USD</option>
                    </select>
                    <input
                      style={inputStyle}
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder={isQuote ? "Price" : "Cost"}
                      value={li.price}
                      onChange={(e) => updateLine(idx, "price", e.target.value)}
                    />
                    {isQuote && (
                      <input
                        style={inputStyle}
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Cost"
                        value={li.cost || ""}
                        onChange={(e) => updateLine(idx, "cost", e.target.value)}
                        title="Optional: set cost to override price book cost for profit calculation"
                      />
                    )}
                    <div className="num" style={{ fontSize: 13.5, paddingTop: 9 }}>
                      {fmtMoney(lineAudTotal(li), "AUD")}
                      {lineCurrency === "USD" && (
                        <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>
                          {fmtMoney(nativeTotal, "USD")}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => removeLine(idx)}
                      title="Remove"
                      style={{ background: "none", border: "none", color: "#a3442e", cursor: "pointer", fontSize: 16, padding: 4 }}
                    >
                      ✕
                    </button>
                  </div>
                  <textarea
                    placeholder="One feature per line — each becomes a bullet point on the quote"
                    value={li.lineNote || ""}
                    onChange={(e) => updateLine(idx, "lineNote", e.target.value)}
                    rows={2}
                    style={{
                      width: "100%", marginTop: 4, marginBottom: 8,
                      fontSize: 12, color: "#6b5240", padding: "6px 8px",
                      border: "1px solid #e3d8c6", borderRadius: 4,
                      fontFamily: "inherit", resize: "vertical", background: "#faf7f3",
                    }}
                  />
                  </React.Fragment>
                );
              })
            )}
            {lines.some((l) => (l.currency || "AUD") === "USD") && (
              <div style={{ fontSize: 11.5, color: "#8a7a66", marginTop: 2, marginBottom: 8 }}>
                USD lines convert to AUD at 1 USD = {rate.toFixed(4)} AUD ({fx && fx.source === "live" ? "live rate" : fx && fx.source === "manual" ? "your manual rate" : "default estimate"}) —
                click the rate badge in the header to update it.
              </div>
            )}
            <div style={{ borderTop: "2px solid #e3d8c6", marginTop: 10, paddingTop: 10 }}>
              <Field label={isQuote ? "Discount (AUD)" : "Adjustment (AUD)"}>
                <input style={inputStyle} type="number" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} />
              </Field>
            </div>
          </Panel>

          {/* Payment Schedule — shown for both quotes and POs, always visible */}
          <Panel>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: "#4a3527", margin: 0 }}>Payment Schedule</h3>
              <Btn
                variant="ghost"
                size="sm"
                onClick={() => setPaymentMilestones([...paymentMilestones, { due: "", amount: "", paid: false, paidDate: "" }])}
              >
                + Add payment
              </Btn>
            </div>

            {paymentMilestones.length === 0 ? (
              <p style={{ fontSize: 12, color: "#8a7a66", margin: 0 }}>No payment milestones yet. Click "+ Add payment" to create one.</p>
            ) : (
              <>
                {/* Compact table — one row per milestone */}
                <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                  {/* Header row */}
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr auto" : "1fr 1fr 80px auto", gap: 8, padding: "4px 0 8px", borderBottom: "1px solid #d3c9b8" }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: "#8a7a66" }}>DUE DATE</span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: "#8a7a66" }}>AMOUNT (AUD)</span>
                    {!isMobile && <span style={{ fontSize: 11, fontWeight: 600, color: "#8a7a66" }}>PAID</span>}
                    <span></span>
                  </div>

                  {paymentMilestones.map((milestone, idx) => (
                    <div key={idx} style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr auto" : "1fr 1fr 80px auto", gap: 8, padding: "8px 0", borderBottom: "1px solid #f0e8d9", alignItems: "center" }}>
                      <input
                        type="date"
                        value={milestone.due || ""}
                        onChange={(e) => {
                          const updated = [...paymentMilestones];
                          updated[idx] = { ...updated[idx], due: e.target.value };
                          setPaymentMilestones(updated);
                        }}
                        style={{ ...inputStyle, margin: 0, width: "100%" }}
                      />
                      <input
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        value={milestone.amount || ""}
                        onChange={(e) => {
                          const updated = [...paymentMilestones];
                          updated[idx] = { ...updated[idx], amount: e.target.value };
                          setPaymentMilestones(updated);
                        }}
                        style={{ ...inputStyle, margin: 0, width: "100%" }}
                      />
                      {!isMobile && (
                        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12 }}>
                          <input
                            type="checkbox"
                            checked={milestone.paid || false}
                            onChange={(e) => {
                              const updated = [...paymentMilestones];
                              updated[idx] = {
                                ...updated[idx],
                                paid: e.target.checked,
                                paidDate: e.target.checked && milestone.due ? milestone.due : updated[idx].paidDate,
                              };
                              setPaymentMilestones(updated);
                            }}
                          />
                          {milestone.paid && <span style={{ color: "#5c7a4f", fontWeight: 600 }}>Paid</span>}
                        </label>
                      )}
                      <button
                        onClick={() => setPaymentMilestones(paymentMilestones.filter((_, i) => i !== idx))}
                        style={{ background: "none", border: "none", color: "#a3442e", cursor: "pointer", fontSize: 16, padding: "0 4px", lineHeight: 1 }}
                        title="Remove"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                {/* Running total */}
                {paymentMilestones.some(m => m.amount) && (
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0 2px", borderTop: "2px solid #b5552b", marginTop: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#4a3527" }}>Total scheduled</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#b5552b" }}>
                      {fmtMoney(paymentMilestones.reduce((s, m) => s + (parseFloat(m.amount) || 0), 0), "AUD")}
                    </span>
                  </div>
                )}
              </>
            )}
          </Panel>

          {!isQuote && !(!isNew && editing?.consolidatedMemberIds?.length > 0) && (
            <Panel>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <Field label="Freight Forward Fee (AUD, optional)">
                    <input
                      style={inputStyle}
                      type="number"
                      step="0.01"
                      min="0"
                      value={customsClearance}
                      onChange={(e) => setCustomsClearance(parseFloat(e.target.value) || 0)}
                      placeholder="e.g. 500"
                    />
                  </Field>
                </div>
                {onCreateCustomsPO && !isNew && customsClearance > 0 && (
                  <div style={{ paddingBottom: 2 }}>
                    <Btn
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        handleSave();
                        onCreateCustomsPO({ ...editing, customsClearance });
                      }}
                    >
                      + Create Customs PO
                    </Btn>
                  </div>
                )}
                {onConsolidatePOs && !isNew && !editing?.consolidatedGroupId && !editing?.consolidatedMemberIds?.length && (
                  <div style={{ paddingBottom: 2 }}>
                    <Btn
                      variant="secondary"
                      size="sm"
                      onClick={() => { setConsolidateSelected([]); setShowConsolidateModal(true); }}
                    >
                      ⊕ Consolidate Shipment
                    </Btn>
                  </div>
                )}
              </div>
            </Panel>
          )}

          {/* Payment Schedule for Accepted Quotes */}
          {isQuote && !isNew && editing.status === "Accepted" && paymentMilestones.filter(m => m.due || m.amount).length > 0 && (
            <Panel>
              <h4 style={{ fontSize: 13, fontWeight: 700, color: "#4a3527", margin: "0 0 12px" }}>
                Payment Schedule
              </h4>
              <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                {paymentMilestones.filter(m => m.due || m.amount).map((m, i) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "8px 0", borderBottom: "1px solid #f0e8d9",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      {m.paid && (
                        <span style={{ fontSize: 11, background: "#d4edda", color: "#2d7a4f", borderRadius: 3, padding: "1px 6px", fontWeight: 600 }}>PAID</span>
                      )}
                      <span style={{ fontSize: 12 }}>
                        {m.due ? new Date(m.due).toLocaleDateString("en-AU") : "Date TBC"}
                      </span>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: m.paid ? "#2d7a4f" : "#b5552b" }}>
                      {m.amount ? `$${parseFloat(m.amount).toLocaleString()}` : "Amount TBC"}
                    </span>
                  </div>
                ))}
                {paymentMilestones.filter(m => m.due || m.amount).length > 1 && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0 2px", borderTop: "2px solid #b5552b", marginTop: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#4a3527" }}>Total</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#b5552b" }}>
                      ${paymentMilestones.filter(m => m.amount).reduce((s, m) => s + (parseFloat(m.amount) || 0), 0).toLocaleString("en-AU", { minimumFractionDigits: 0 })}
                    </span>
                  </div>
                )}
              </div>
            </Panel>
          )}

          {/* Prompt to add payment milestones for accepted quotes */}
          {isQuote && !isNew && editing.status === "Accepted" && paymentMilestones.filter(m => m.due || m.amount).length === 0 && (
            <Panel style={{ backgroundColor: "#fffbf0", borderLeft: "4px solid #d4a574" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <h4 style={{ fontSize: 13, fontWeight: 700, color: "#4a3527", margin: "0 0 6px" }}>
                    📋 Add Payment Schedule
                  </h4>
                  <p style={{ fontSize: 12, color: "#6b5240", margin: 0 }}>
                    Click "Payment Milestones" to add payment terms for this accepted quote.
                  </p>
                </div>
              </div>
            </Panel>
          )}

          {!isNew && editing?.consolidatedMemberIds?.length > 0 && (() => {
            const members = (db.pos || []).filter(p => (editing.consolidatedMemberIds || []).includes(p.id));
            const allPOs = [editing, ...members];

            // Helper: sum a PO's lines regardless of whether they use qty/price or quantity/unitPrice/amount
            const sumLines = (poLines) => (poLines || []).reduce((s, l) => {
              const qty = Number(l.qty || l.quantity || 1);
              const price = Number(l.price || l.unitPrice || 0);
              const amt = Number(l.amount || 0);
              const lineTotal = amt || qty * price;
              return s + lineTotal;
            }, 0);

            // For the primary PO use the live local-state total (reflects any unsaved edits);
            // fall back to stored editing.total if lines compute to zero (different field names).
            // For member POs use stored total, falling back to summing their lines.
            const poTotal = (p) => {
              if (p.id === editing.id) return total || editing.total || sumLines(lines);
              return p.total || sumLines(p.lines);
            };
            const poSubtotalVal = (p) => {
              if (p.id === editing.id) return subtotal || editing.subtotal || sumLines(lines);
              // For member POs: use subtotal if available, otherwise calculate from lines
              const calculated = sumLines(p.lines);
              console.log(`📊 poSubtotalVal for PO#${p.number}: subtotal=${p.subtotal}, calculated=${calculated}, lines=${p.lines?.length || 0}`);
              return p.subtotal || calculated;
            };

            const groupTotal = allPOs.reduce((s, p) => s + poTotal(p), 0);

            // Strip any leading "PO-" prefix so we can format as PO5006/5007, not POPO-5006/PO-5007
            const stripPO = (n) => String(n).replace(/^PO-?/i, "");
            const consolidatedPONumber = `PO${stripPO(editing.number)}/${members.map(m => stripPO(m.number)).join("/")}`;

            const generateConsolidatedPDF = () => {
              console.log("📄 Generating PDF with POs:", allPOs.map(p => ({ number: p.number, supplierNote: p.supplierNote })));
              const html = `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                  ${allPOs.map((po, idx) => `
                    <div style="${idx > 0 ? 'page-break-before: always; ' : ''}padding-top: 20px;">
                      <h2 style="text-align: center; margin-bottom: 20px;">Purchase Order</h2>
                      <h3 style="font-size: 16px; margin-bottom: 5px;">PO-${stripPO(po.number)}</h3>
                      ${po.customer ? `<p style="margin: 0; font-size: 14px; color: #666;">Customer: ${po.customer}</p>` : ""}
                      
                      <h4 style="margin-top: 20px; margin-bottom: 10px; font-size: 13px;">Line Items</h4>
                      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                        <thead>
                          <tr style="background-color: #f5f5f5; border-bottom: 2px solid #333;">
                            <th style="text-align: left; padding: 8px; border: 1px solid #ddd; font-size: 12px;">Description</th>
                            <th style="text-align: center; padding: 8px; border: 1px solid #ddd; font-size: 12px; width: 80px;">Qty</th>
                            <th style="text-align: right; padding: 8px; border: 1px solid #ddd; font-size: 12px; width: 100px;">Unit Price</th>
                            <th style="text-align: right; padding: 8px; border: 1px solid #ddd; font-size: 12px; width: 100px;">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${(po.lines || []).map(line => `
                            <tr>
                              <td style="padding: 8px; border: 1px solid #ddd; font-size: 12px;">${line.desc || line.description || ""}</td>
                              <td style="padding: 8px; border: 1px solid #ddd; text-align: center; font-size: 12px;">${line.qty || line.quantity || 1}</td>
                              <td style="padding: 8px; border: 1px solid #ddd; text-align: right; font-size: 12px;">$${(parseFloat(line.price || line.unitPrice || 0)).toLocaleString()}</td>
                              <td style="padding: 8px; border: 1px solid #ddd; text-align: right; font-size: 12px;">$${((parseFloat(line.price || line.unitPrice || 0) * (line.qty || line.quantity || 1))).toLocaleString()}</td>
                            </tr>`).join("")}
                          <tr style="background-color: #f5f5f5; font-weight: bold;">
                            <td colspan="3" style="padding: 8px; border: 1px solid #ddd; text-align: right; font-size: 12px;">Subtotal:</td>
                            <td style="padding: 8px; border: 1px solid #ddd; text-align: right; font-size: 12px;">$${(poSubtotalVal(po) || 0).toLocaleString()}</td>
                          </tr>
                          ${poTotal(po) !== poSubtotalVal(po) ? `
                            <tr style="font-weight: bold;">
                              <td colspan="3" style="padding: 8px; border: 1px solid #ddd; text-align: right; font-size: 12px;">Total:</td>
                              <td style="padding: 8px; border: 1px solid #ddd; text-align: right; font-size: 12px;">$${(Number(poTotal(po)) || 0).toLocaleString()}</td>
                            </tr>` : ""}
                        </tbody>
                      </table>
                      ${idx === allPOs.length - 1 ? `
                        ${po.notes ? `
                          <div style="margin-bottom: 20px; padding: 10px; background-color: #f9f5f0; border-left: 3px solid #d4a574;">
                            <h4 style="margin: 0 0 5px 0; font-size: 12px;">Notes</h4>
                            <p style="margin: 0; font-size: 12px; white-space: pre-wrap;">${po.notes}</p>
                          </div>` : ""}
                        
                        ${po.supplierNote ? `
                          <div style="margin-bottom: 20px; padding: 10px; background-color: #f0f8ff; border-left: 3px solid #4a7ba7;">
                            <h4 style="margin: 0 0 5px 0; font-size: 12px; color: #2c5aa0;">Supplier Instructions</h4>
                            <p style="margin: 0; font-size: 12px; white-space: pre-wrap; color: #1a3a6e;">${po.supplierNote}</p>
                          </div>` : ""}
                      ` : ""}
                    </div>`).join("")}
                </div>`;
              const el = document.createElement("div");
              el.innerHTML = html;
              html2pdf().set({
                margin: 10,
                filename: `ConsolidatedPO-${stripPO(editing.number)}.pdf`,
                image: { type: "jpeg", quality: 0.98 },
                html2canvas: { scale: 2 },
                jsPDF: { orientation: "portrait", unit: "mm", format: "a4" },
              }).from(el).save();
            };

            // One tab per PO, plus a Summary tab
            const tabList = [
              { id: "summary", label: "Summary" },
              ...allPOs.map(po => ({ id: po.id, label: `PO-${stripPO(po.number)}` })),
            ];
            const activeTab = consolidatedTab && (consolidatedTab === "summary" || allPOs.find(p => p.id === consolidatedTab))
              ? consolidatedTab
              : allPOs[0]?.id || "summary";

            return (
              <Panel>
                {/* Header */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                  <h4 style={{ fontSize: 13, fontWeight: 700, color: "#4a3527", margin: 0 }}>
                    {consolidatedPONumber} — {allPOs.length} POs
                  </h4>
                </div>

                {/* Tab bar — works on mobile and desktop */}
                <div style={{ display: "flex", gap: 4, marginBottom: 14, borderBottom: "2px solid #e3d8c6", flexWrap: "wrap" }}>
                  {tabList.map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setConsolidatedTab(tab.id)}
                      style={{
                        padding: isMobile ? "7px 10px" : "8px 14px",
                        fontSize: isMobile ? 11 : 12,
                        fontWeight: activeTab === tab.id ? 700 : 500,
                        background: activeTab === tab.id ? "#b5552b" : "transparent",
                        color: activeTab === tab.id ? "#fff" : "#6b5240",
                        border: "none",
                        borderRadius: "4px 4px 0 0",
                        cursor: "pointer",
                        marginBottom: -2,
                        borderBottom: activeTab === tab.id ? "2px solid #b5552b" : "2px solid transparent",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* Summary tab */}
                {activeTab === "summary" && (
                  <div>
                    {allPOs.map(po => (
                      <div key={po.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #f0e8d9", fontSize: 12 }}>
                        <div>
                          <strong>PO-{stripPO(po.number)}</strong>
                          {po.customer && <span style={{ color: "#8a7a66" }}> — {po.customer}</span>}
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontWeight: 600 }}>${poTotal(po).toLocaleString()}</div>
                          {po.customsClearance > 0 && <div style={{ fontSize: 11, color: "#8a7a66" }}>Customs: ${po.customsClearance.toLocaleString()}</div>}
                        </div>
                      </div>
                    ))}

                    <div style={{ margin: "14px 0", padding: 12, background: "#f9f5f0", borderRadius: 4 }}>
                      <label style={{ fontSize: 12, fontWeight: 600, color: "#6b5240", display: "block", marginBottom: 8 }}>
                        Freight Forward Fee (AUD)
                      </label>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 11, color: "#8a7a66" }}>$</span>
                        <input
                          type="number"
                          value={consolidatedCustoms}
                          onChange={(e) => {
                            const value = parseFloat(e.target.value) || 0;
                            setConsolidatedCustoms(value);
                            setCustomsClearance(value);  // Sync to customsClearance for saving
                          }}
                          style={{ flex: 1, padding: "6px 8px", fontSize: 12, border: "1px solid #d4a574", borderRadius: 3 }}
                        />
                      </div>
                      {customsClearance > 0 && (
                        <div style={{ marginTop: 8 }}>
                          <Btn variant="secondary" size="sm" onClick={() => onSplitCustoms && onSplitCustoms(editing, customsClearance)}>
                            Split ${customsClearance.toLocaleString()} freight 50/50
                          </Btn>
                          <p style={{ fontSize: 11, color: "#8a7a66", margin: "4px 0 0" }}>
                            {allPOs.map(po => `PO-${stripPO(po.number)}: $${Math.round((customsClearance / allPOs.length) * 100) / 100}`).join(" · ")}
                          </p>
                        </div>
                      )}
                    </div>

                    {paymentMilestones.filter(m => m.due || m.amount).length > 0 && (
                      <div style={{ marginBottom: 14 }}>
                        <h5 style={{ fontSize: 12, fontWeight: 600, color: "#6b5240", marginBottom: 10 }}>Payment Schedule</h5>
                        {paymentMilestones.filter(m => m.due || m.amount).map((m, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #f0e8d9", fontSize: 11 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              {m.paid && <span style={{ background: "#d4edda", color: "#2d7a4f", borderRadius: 3, padding: "1px 6px", fontWeight: 600, fontSize: 10 }}>PAID</span>}
                              <span style={{ color: "#6b5240" }}>{m.due ? new Date(m.due).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "Date TBC"}</span>
                            </div>
                            <span style={{ fontWeight: 600, color: m.paid ? "#2d7a4f" : "#b5552b" }}>
                              {m.amount ? `$${parseFloat(m.amount).toLocaleString()}` : "Amount TBC"}
                            </span>
                          </div>
                        ))}
                        {paymentMilestones.filter(m => m.due || m.amount).length > 1 && (
                          <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0 2px", borderTop: "2px solid #b5552b", marginTop: 4 }}>
                            <span style={{ fontWeight: 600, color: "#4a3527", fontSize: 12 }}>Total</span>
                            <span style={{ fontWeight: 700, color: "#b5552b", fontSize: 12 }}>
                              ${paymentMilestones.filter(m => m.amount).reduce((s, m) => s + (parseFloat(m.amount) || 0), 0).toLocaleString()}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    <div style={{ padding: 12, background: "#b5552b", color: "#fff", borderRadius: 4, textAlign: "center" }}>
                      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>CONSOLIDATED TOTAL</div>
                      <div style={{ fontSize: 16, fontWeight: 700 }}>${(Number(groupTotal) || 0).toLocaleString()}</div>
                    </div>
                  </div>
                )}

                {/* Per-PO tabs */}
                {allPOs.map(po => activeTab === po.id && (
                  <div key={po.id}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#4a3527", marginBottom: 12 }}>
                      PO-{stripPO(po.number)}{po.customer ? ` — ${po.customer}` : ""}
                    </div>
                    {po.lines && po.lines.length > 0 ? (
                      <div>
                        {po.lines.map((line, li) => (
                          <div key={li} style={{ padding: "9px 0", borderBottom: li < po.lines.length - 1 ? "1px solid #f0e8d9" : "none", fontSize: 12 }}>
                            <div style={{ fontWeight: 600, color: "#4a3527" }}>{line.desc || line.description || "Item"}</div>
                            <div style={{ display: "flex", gap: 16, marginTop: 3, flexWrap: "wrap" }}>
                              {(line.qty || line.quantity) && <span style={{ color: "#8a7a66", fontSize: 11 }}>Qty: {line.qty || line.quantity}</span>}
                              {(line.price || line.unitPrice) && <span style={{ color: "#8a7a66", fontSize: 11 }}>Unit: ${parseFloat(line.price || line.unitPrice || 0).toLocaleString()}</span>}
                              <span style={{ fontWeight: 600, color: "#b5552b", fontSize: 11 }}>
                                ${(parseFloat(line.amount) || ((parseFloat(line.qty) || 0) * (parseFloat(line.price) || 0))).toLocaleString()}
                              </span>
                            </div>
                          </div>
                        ))}
                        <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0 2px", borderTop: "2px solid #d4a574", marginTop: 6 }}>
                          <span style={{ fontWeight: 700, color: "#4a3527", fontSize: 12 }}>Subtotal</span>
                          <span style={{ fontWeight: 700, color: "#4a3527", fontSize: 12 }}>
                            ${(Number(poSubtotalVal(po)) || 0).toLocaleString()}
                          </span>
                        </div>
                        {poTotal(po) !== poSubtotalVal(po) && (
                          <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 4 }}>
                            <span style={{ fontWeight: 700, color: "#b5552b", fontSize: 12 }}>Total</span>
                            <span style={{ fontWeight: 700, color: "#b5552b", fontSize: 12 }}>
                              ${(Number(poTotal(po)) || 0).toLocaleString()}
                            </span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p style={{ fontSize: 12, color: "#8a7a66" }}>No line items on this PO.</p>
                    )}
                    
                    {/* Notes section for this PO */}
                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "2px solid #d4a574" }}>
                      <label style={{ fontSize: 12, fontWeight: 600, color: "#6b5240", display: "block", marginBottom: 8 }}>
                        Notes (Delivery instructions, terms)
                      </label>
                      <textarea
                        value={po.id === editing.id ? notes : (po.notes || "")}
                        onChange={(e) => {
                          if (po.id === editing.id) {
                            // Primary PO - update local state
                            setNotes(e.target.value);
                          } else {
                            // Member PO - save directly to Supabase
                            savePONotes(po.id, e.target.value);
                          }
                        }}
                        style={{ 
                          width: "100%", 
                          minHeight: 60, 
                          padding: "8px", 
                          fontSize: 12, 
                          border: "1px solid #d4a574", 
                          borderRadius: 4,
                          fontFamily: "inherit",
                          resize: "vertical"
                        }}
                        placeholder="Optional"
                      />
                    </div>
                    
                    {/* Supplier Notes section for this PO */}
                    <div style={{ marginTop: 14, padding: 12, backgroundColor: "#f0f8ff", borderTop: "2px solid #4a7ba7", borderRadius: 4 }}>
                      <label style={{ fontSize: 12, fontWeight: 600, color: "#2c5aa0", display: "block", marginBottom: 8 }}>
                        Supplier Notes (Instructions to supplier)
                      </label>
                      <textarea
                        value={po.id === editing.id ? supplierNote : (po.supplierNote || "")}
                        onChange={(e) => {
                          if (po.id === editing.id) {
                            // Primary PO - update local state
                            setSupplierNote(e.target.value);
                          } else {
                            // Member PO - save directly to Supabase
                            savePOSupplierNote(po.id, e.target.value);
                          }
                        }}
                        style={{ 
                          width: "100%", 
                          minHeight: 60, 
                          padding: "8px", 
                          fontSize: 12, 
                          border: "1px solid #4a7ba7", 
                          borderRadius: 4,
                          fontFamily: "inherit",
                          resize: "vertical",
                          backgroundColor: "#fff"
                        }}
                        placeholder="Optional - Instructions or notes for the supplier"
                      />
                    </div>
                  </div>
                ))}
              </Panel>
            );
          })()}

          {!(!isQuote && !isNew && editing?.consolidatedMemberIds?.length > 0) && (
            <Panel>
              <Field label={isQuote ? "Notes (terms, validity, inclusions)" : "Notes (delivery instructions, terms)"}>
                <textarea
                  style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
                  placeholder="Optional"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </Field>
            </Panel>
          )}

          {/* Attachments section */}
          <Panel style={{ marginTop: 16 }}>
            <h4 style={{ fontSize: 13, fontWeight: 600, color: "#6b5240", margin: "0 0 10px" }}>Attachments</h4>
            {editing && (
              <AttachmentsPanel
                recordId={editing.id}
                recordType={isQuote ? "quotes" : "purchase_orders"}
                attachments={attachments}
                onAttachmentsChange={setAttachments}
              />
            )}
            {!editing && (
              <p style={{ fontSize: 12, color: "#8a7a66" }}>Attachments will be available after saving.</p>
            )}
          </Panel>
        </fieldset>

        {/* ---------------- LIVE PREVIEW SIDE ---------------- */}
        <div>
          <div className="doc-paper" ref={printRef} style={{ position: "sticky", top: 0 }}>
            {(() => {
              const isConsolidated = !isQuote && !isNew && editing?.consolidatedMemberIds?.length > 0;
              const consolidatedMembers = isConsolidated
                ? (db.pos || []).filter(p => (editing.consolidatedMemberIds || []).includes(p.id))
                : [];
              const allConsolidatedPOs = isConsolidated ? [editing, ...consolidatedMembers] : [];
              const stripPO = (n) => String(n).replace(/^PO-?/i, "");

              // Which PO is active in the preview? Default to the primary.
              const activePo = isConsolidated
                ? (allConsolidatedPOs.find(p => p.id === previewPoId) || allConsolidatedPOs[0])
                : null;

              // Lines: use live local state for the primary PO (reflects unsaved edits),
              // stored lines for member POs
              const previewLines = isConsolidated
                ? (activePo?.id === editing?.id
                    ? lines
                    : (activePo?.lines || []).map(l => ({ currency: "AUD", ...l })))
                : lines;

              const previewSubtotal = isConsolidated && activePo?.id !== editing?.id
                ? (activePo?.subtotal || 0) : subtotal;
              const previewTotal = isConsolidated && activePo?.id !== editing?.id
                ? (activePo?.total || 0) : total;
              const previewDiscount = isConsolidated && activePo?.id !== editing?.id
                ? (activePo?.discount || 0) : discountNum;

              return (
                <>
                  <div className="doc-header">
                    <div style={{ minWidth: 0 }}>
                      <h2 style={{ fontSize: isMobile ? 20 : 22, fontWeight: 700, marginBottom: 6 }}>
                        {isQuote ? "Customer Quote" : "Purchase Order"}
                      </h2>

                      {isConsolidated ? (
                        /* Tab strip replaces the PO number for consolidated POs */
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
                          {allConsolidatedPOs.map(po => {
                            const isActive = (previewPoId || allConsolidatedPOs[0]?.id) === po.id;
                            return (
                              <button
                                key={po.id}
                                onClick={() => setPreviewPoId(po.id)}
                                style={{
                                  padding: isMobile ? "5px 9px" : "6px 13px",
                                  fontSize: isMobile ? 11 : 12,
                                  fontWeight: isActive ? 700 : 500,
                                  background: isActive ? "#6b5240" : "#f0e8d9",
                                  color: isActive ? "#fff" : "#6b5240",
                                  border: "1px solid " + (isActive ? "#6b5240" : "#d4c4b0"),
                                  borderRadius: 4,
                                  cursor: "pointer",
                                  whiteSpace: "nowrap",
                                  letterSpacing: "0.01em",
                                }}
                              >
                                PO-{stripPO(po.number)}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <h3 style={{ fontSize: 15, fontWeight: 600, color: "#6b5240", marginBottom: 8, wordBreak: "break-word", overflowWrap: "break-word" }}>
                          {isNew ? "Draft — not yet saved" : `#${editing.number}`}
                        </h3>
                      )}

                      <div style={{ color: "#8a7a66", fontSize: 13 }}>
                        {isNew ? "" : fmtDate(isConsolidated ? (activePo?.date || date) : date)}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <strong style={{ fontFamily: "Georgia,serif", color: "#4a3527" }}>Austral Motorhomes & Platinum Pontoons</strong>
                      <br />
                      <span className="muted" style={{ fontSize: 12 }}>
                        Kunda Park, QLD
                      </span>
                    </div>
                  </div>

                  <div className="doc-meta">
                    {isQuote ? (
                      <div style={{ textAlign: "left" }}>
                        <div style={{ fontWeight: 700, fontSize: 15 }}>{party || "—"}</div>
                        {contact && (
                          <div style={{ fontSize: 13, color: "#6b5240", marginTop: 2 }}>{contact}</div>
                        )}
                        <div style={{ marginTop: 32 }} />
                      </div>
                    ) : (
                      <>
                        <div><b>Supplier:</b> {party || "—"}</div>
                        {isConsolidated && activePo?.customer && (
                          <div><b>Customer:</b> {activePo.customer}</div>
                        )}
                        {model && <div><b>Reference:</b> {model}</div>}
                        {contact && <div><b>Contact:</b> {contact}</div>}
                        {eta && <div><b>ETA:</b> {fmtDate(eta)}</div>}
                      </>
                    )}
                  </div>

                  {previewLines.length === 0 ? (
                    <p className="muted" style={{ fontSize: 13 }}>
                      {isConsolidated ? "No line items on this PO." : "Add line items on the left to see them appear here."}
                    </p>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>Description</th>
                          <th className="num">Qty</th>
                          <th className="num">{isQuote ? "Price" : "Cost"}</th>
                          <th className="num">Line total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewLines.map((li, idx) => (
                          <React.Fragment key={idx}>
                            <tr>
                              <td>{li.desc || <span className="muted">(no description)</span>}</td>
                              <td className="num">{li.qty}</td>
                              <td className="num">{fmtMoney(li.price, li.currency || "AUD")}</td>
                              <td className="num">{fmtMoney(lineAudTotal(li), "AUD")}</td>
                            </tr>
                            {li.lineNote && li.lineNote.trim() && (() => {
                              const bullets = li.lineNote.split("\n").map(l => l.trim()).filter(Boolean);
                              return (
                                <tr>
                                  <td colSpan={4} style={{ paddingLeft: 24, paddingTop: 4, paddingBottom: 8, borderTop: "none" }}>
                                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#6b5240", lineHeight: 1.7 }}>
                                      {bullets.map((b, bi) => <li key={bi}>{b}</li>)}
                                    </ul>
                                  </td>
                                </tr>
                              );
                            })()}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  )}

                  <div style={{ marginTop: 30, paddingTop: 20, borderTop: "2px solid #e3d8c6" }}>
                    <div className="totals-row">
                      <span>Subtotal (incl. GST)</span>
                      <span>{fmtMoney(previewSubtotal, "AUD")}</span>
                    </div>
                    {previewDiscount > 0 && (
                      <div className="totals-row" style={{ marginTop: 12 }}>
                        <span>{isQuote ? "Discount" : "Adjustment"}</span>
                        <span>{(isQuote ? "-" : "") + fmtMoney(previewDiscount, "AUD")}</span>
                      </div>
                    )}
                    <div className="totals-row grand" style={{ marginTop: 18 }}>
                      <span>Total (incl. GST)</span>
                      <span>{fmtMoney(previewTotal, "AUD")}</span>
                    </div>

                    {isQuote && (
                      <div className="no-print" style={{ borderTop: "1px solid #e3d8c6", marginTop: 20, paddingTop: 12, fontSize: 11, color: "#8a7a66" }}>
                        (Gross profit details for internal use only)
                      </div>
                    )}
                    {isQuote && !hasCostData && lines.length > 0 && (
                      <div className="no-print" style={{ fontSize: 11, color: "#8a7a66", marginTop: 4 }}>
                        Gross profit isn't shown for manually-added lines with no linked price book cost.
                      </div>
                    )}
                  </div>
                </>
              );
            })()}



            {/* Cost and Profit Summary - screen only (excluded from PDF) */}
            {isQuote && hasCostData && (
              <div className="no-print" style={{ display: "block" }} data-no-print="true">
                {/* Collapsible Header */}
                <div
                  onClick={() => setShowProfitSection(!showProfitSection)}
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    alignItems: "center",
                    background: "#f6f1e7",
                    border: "1px solid #d3c9b8",
                    borderRadius: showProfitSection ? "8px 8px 0 0" : 8,
                    padding: 12,
                    marginTop: 14,
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#6b5240",
                    userSelect: "none",
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = "#f0e8d9"}
                  onMouseLeave={(e) => e.currentTarget.style.background = "#f6f1e7"}
                >
                  <span style={{ fontSize: 16, transition: "transform 0.3s ease", transform: showProfitSection ? "rotate(180deg)" : "rotate(0deg)" }}>▼</span>
                </div>

                {/* Collapsible Content */}
                {showProfitSection && (
                  <div
                    style={{
                      background: "#f6f1e7",
                      border: "1px solid #d3c9b8",
                      borderRadius: "0 0 8px 8px",
                      borderTop: "none",
                      padding: 12,
                      fontSize: 13,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ color: "#6b5240", fontWeight: 600 }}>Total Cost (AUD):</span>
                      <span style={{ fontWeight: 700, color: "#4a3527" }}>{fmtMoney(knownCostTotal, "AUD")}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: "#6b5240", fontWeight: 600 }}>Gross Profit %:</span>
                      <span
                        style={{
                          fontWeight: 700,
                          color: grossProfitPct != null && grossProfitPct < 0 ? "#a3442e" : "#5c7a4f",
                        }}
                      >
                        {grossProfitPct != null ? `${grossProfitPct.toFixed(1)}%` : "—"}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div style={{ fontSize: 11, color: "#8a7a66", marginTop: 10 }}>
              All prices include GST.
              {lines.some((l) => (l.currency || "AUD") === "USD") && ` USD lines converted at 1 USD = ${rate.toFixed(4)} AUD.`}
              {isQuote && " Quote valid for 7 days."}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{
            background: "#fbeae5",
            border: "1px solid #e6c9bf",
            color: "#a3442e",
            borderRadius: 8,
            padding: "9px 12px",
            fontSize: 13,
            marginTop: 16,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 18, flexWrap: "wrap", gap: 10 }}>
        <div>
          {!isNew && onDelete && (
            <Btn variant="danger" onClick={() => onDelete(editing)}>
              Delete
            </Btn>
          )}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {!isNew && (
            <>
              <Btn 
                variant="ghost" 
                onClick={() => {
                  try {
                    window.print();
                  } catch (e) {
                    alert("Print: " + e.message);
                  }
                }}
              >
                Print
              </Btn>
              <Btn 
                variant="ghost" 
                onClick={() => {
                  try {
                    // Clone the preview and explicitly remove every .no-print element
                    // (gross profit, internal-only notes, etc.) from the clone before
                    // building the HTML string. This is a certain fix, unlike relying
                    // on the .no-print CSS rule alone — .remove() guarantees the node
                    // is gone from the resulting HTML, with no dependency on whether
                    // html2canvas's rendering pipeline honours display:none in every case.
                    const clone = printRef.current ? printRef.current.cloneNode(true) : null;
                    if (clone) {
                      clone.querySelectorAll(".no-print").forEach((el) => el.remove());
                      clone.querySelectorAll("[data-no-print]").forEach((el) => el.remove());
                      // Also strip any element whose text starts with "(" (internal notes)
                      clone.querySelectorAll("div").forEach((el) => {
                        if (el.textContent.trim().startsWith("(Gross profit")) el.remove();
                      });
                    }
                    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { margin: 0; padding: 0; }
body { font-family: Georgia, serif; color: #2b2018; padding: 40px; line-height: 1.7; }
.doc-header { border-bottom: 3px solid #b5552b; padding-bottom: 30px; margin-bottom: 40px; }
h2 { font-size: 26px; font-weight: 700; margin-bottom: 8px; }
.doc-info { margin: 20px 0; font-size: 14px; }
.doc-info p { margin: 6px 0; }
table { width: 100%; border-collapse: collapse; margin: 40px 0; }
th { text-align: left; border-bottom: 2px solid #b5552b; padding: 12px 12px 12px 0; font-size: 12px; font-weight: 700; }
th.num { text-align: right; padding-right: 0; }
td { padding: 14px 12px 14px 0; border-bottom: 1px solid #e3d8c6; font-size: 14px; }
td.num { text-align: right; padding-right: 0; }
.totals { margin: 40px 0; }
.totals-row { display: flex; justify-content: space-between; padding: 10px 0; font-size: 14px; }
.grand { font-weight: 800; font-size: 18px; border-top: 2px solid #b5552b; border-bottom: 1px solid #b5552b; padding: 16px 0; margin-top: 20px; }
.notes { margin-top: 50px; padding-top: 30px; border-top: 1px solid #e3d8c6; font-size: 13px; }
.footer { margin-top: 40px; font-size: 11px; color: #8a7a66; }
.no-print { display: none !important; }
</style>
</head>
<body>
${clone?.innerHTML || ""}
</body>
</html>`;
                    // Real PDF generation via html2pdf.js (html2canvas + jsPDF under the
                    // hood) — confirmed API: html2pdf().set(opt).from(src, 'string').save()
                    const worker = html2pdf().set({
                      margin: 10,
                      filename: `${editing?.number || "quote"}.pdf`,
                      image: { type: "jpeg", quality: 0.98 },
                      html2canvas: { scale: 2 },
                      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
                    }).from(html, "string");

                    if (isMobile) {
                      // .save() relies on a synthetic <a download> click, which is
                      // known to be unreliable on mobile Safari and some Android
                      // browsers. Opening the PDF blob in a new tab instead lets the
                      // browser's native PDF viewer handle it (with its own
                      // Share/Save option) — a more reliable path on mobile.
                      // NOTE: this has not been tested on an actual mobile device;
                      // please verify it works on yours after deploying.
                      worker.outputPdf("blob").then((blob) => {
                        const url = URL.createObjectURL(blob);
                        window.open(url, "_blank");
                      }).catch((e) => {
                        alert("PDF generation error: " + (e?.message || e));
                      });
                    } else {
                      worker.save().catch((e) => {
                        alert("PDF generation error: " + (e?.message || e));
                      });
                    }
                  } catch (e) {
                    alert("Error: " + e.message);
                  }
                }}
              >
                Download PDF
              </Btn>
              {isQuote && editing.status !== "Accepted" && (
                <Btn variant="primary" onClick={() => handleStatusChange("Accepted")}>
                  Accept Quote
                </Btn>
              )}
              {isQuote && editing.status === "Accepted" && onGeneratePOs && (
                <Btn variant="primary" onClick={() => onGeneratePOs(editing)}>
                  Generate POs
                </Btn>
              )}
              {!isQuote && editing.quoteId && openRecord && (
                <Btn variant="secondary" onClick={() => openRecord("quote", editing.quoteId)}>
                  View original quote
                </Btn>
              )}
            </>
          )}
          {onReverseConsolidation && !isNew && editing?.consolidatedMemberIds?.length > 0 && (
            <Btn variant="secondary" onClick={() => onReverseConsolidation(editing)}>
              ⊖ Reverse Consolidation
            </Btn>
          )}
          <Btn variant="ghost" onClick={onCancel}>
            {isNew ? "Cancel" : "Close"}
          </Btn>
          <Btn variant="primary" onClick={handleSave}>
            {isNew ? `Create ${isQuote ? "quote" : "PO"}` : "Save changes"}
          </Btn>
        </div>
      </div>

      {showPaymentModal && !isNew && (
        <PaymentMilestonesModal
          doc={editing}
          docType={isQuote ? "quote" : "po"}
          onSave={onSaveMilestones}
          onClose={() => setShowPaymentModal(false)}
        />
      )}

      {showQuickAddItem && onAddItem && (
        <ItemModal
          editing={null}
          models={models}
          categories={categories}
          suppliers={db ? db.suppliers : []}
          fx={fx}
          onAddModel={onAddModel}
          onAddCategory={onAddCategory}
          onCancel={() => setShowQuickAddItem(false)}
          onSave={(payload) => handleQuickAddItem(payload)}
        />
      )}

      {showConsolidateModal && !isNew && onConsolidatePOs && (() => {
        // POs from same supplier, not already in a consolidated group, not this PO
        const candidatePOs = (db.pos || []).filter(p =>
          p.id !== editing.id &&
          p.party === editing.party &&
          !p.consolidatedGroupId &&
          !(editing.consolidatedMemberIds || []).includes(p.id)
        );
        return (
          <Modal onClose={() => setShowConsolidateModal(false)} width={540}>
            <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 8px", fontSize: 18 }}>
              Consolidate Shipment
            </h3>
            <p style={{ fontSize: 12, color: "#8a7a66", margin: "0 0 16px" }}>
              Select POs from <strong>{editing.party}</strong> to combine into a single shipment with PO #{editing.number}.
            </p>
            {candidatePOs.length === 0 ? (
              <p style={{ color: "#8a7a66", fontSize: 13 }}>No other POs found for {editing.party}.</p>
            ) : (
              <div>
                {candidatePOs.map(po => (
                  <label key={po.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid #f0e8d9", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={consolidateSelected.includes(po.id)}
                      onChange={(e) => setConsolidateSelected(prev =>
                        e.target.checked ? [...prev, po.id] : prev.filter(id => id !== po.id)
                      )}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#4a3527" }}>PO #{po.number}</div>
                      <div style={{ fontSize: 12, color: "#8a7a66" }}>
                        {po.customer && `Customer: ${po.customer}`}
                        {po.quoteNumber && ` · Quote ${po.quoteNumber}`}
                        {` · $${(po.total || 0).toLocaleString()}`}
                        {` · ${po.status}`}
                      </div>
                    </div>
                  </label>
                ))}
                <div style={{ marginTop: 16, padding: "10px 0", borderTop: "1px solid #e3d8c6", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: 12, color: "#8a7a66" }}>
                    {consolidateSelected.length > 0
                      ? `Combined total: $${[editing, ...candidatePOs.filter(p => consolidateSelected.includes(p.id))].reduce((s, p) => s + (p.total || 0), 0).toLocaleString()}`
                      : "Select POs above to combine"}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Btn variant="ghost" onClick={() => setShowConsolidateModal(false)}>Cancel</Btn>
                    <Btn
                      variant="primary"
                      onClick={() => {
                        if (consolidateSelected.length === 0) return;
                        const memberPOs = candidatePOs.filter(p => consolidateSelected.includes(p.id));
                        onConsolidatePOs(editing, memberPOs);
                        setShowConsolidateModal(false);
                      }}
                    >
                      Consolidate {consolidateSelected.length > 0 ? `(${consolidateSelected.length + 1} POs)` : ""}
                    </Btn>
                  </div>
                </div>
              </div>
            )}
          </Modal>
        );
      })()}
    </Modal>
  );
}

function POGenerationModal({ quote, items, suppliers, onCancel, onGenerate }) {
  // Group quote lines by supplier
  const supplierGroups = {};
  quote.lines.forEach((line) => {
    const item = items.find((i) => i.id === line.itemId);
    const supplierName = item?.supplier || "Unknown supplier";
    if (!supplierGroups[supplierName]) {
      supplierGroups[supplierName] = [];
    }
    supplierGroups[supplierName].push(line);
  });

  const [selectedSuppliers, setSelectedSuppliers] = useState(Object.keys(supplierGroups));

  function handleGenerate() {
    const supplierMap = {};
    selectedSuppliers.forEach((supplierName) => {
      supplierMap[supplierName] = {
        name: supplierName,
        // Replace line price with item cost for POs
        lines: supplierGroups[supplierName].map((line) => {
          const item = items.find((i) => i.id === line.itemId);
          const costPrice = item ? (item.cost || 0) : 0;
          return { ...line, price: costPrice };
        }),
      };
    });
    onGenerate(supplierMap);
  }

  const supplierList = Object.keys(supplierGroups);

  return (
    <Modal onClose={onCancel}>
      <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 16px", fontSize: 19 }}>
        Generate Purchase Orders
      </h3>
      <p style={{ color: "#6b5240", fontSize: 13, margin: "0 0 14px" }}>
        Create purchase orders for each supplier. Select which suppliers to include:
      </p>

      <div style={{ background: "#f9f7f2", border: "1px solid #e3d8c6", borderRadius: 8, padding: 12, marginBottom: 14 }}>
        {supplierList.length === 0 ? (
          <p style={{ color: "#8a7a66", margin: 0, fontSize: 13 }}>No suppliers found in quote line items. Add items with suppliers first.</p>
        ) : (
          supplierList.map((supplierName) => (
            <div key={supplierName} style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="checkbox"
                id={`sup-${supplierName}`}
                checked={selectedSuppliers.includes(supplierName)}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSelectedSuppliers([...selectedSuppliers, supplierName]);
                  } else {
                    setSelectedSuppliers(selectedSuppliers.filter((s) => s !== supplierName));
                  }
                }}
              />
              <label htmlFor={`sup-${supplierName}`} style={{ flex: 1, margin: 0, cursor: "pointer", fontSize: 13 }}>
                <strong>{supplierName}</strong>
                <div style={{ fontSize: 11, color: "#8a7a66" }}>
                  {supplierGroups[supplierName].length} item{supplierGroups[supplierName].length !== 1 ? "s" : ""}
                </div>
              </label>
            </div>
          ))
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
        <Btn variant="ghost" onClick={onCancel}>
          Cancel
        </Btn>
        <Btn variant="primary" onClick={handleGenerate} disabled={selectedSuppliers.length === 0}>
          Create {selectedSuppliers.length} PO{selectedSuppliers.length !== 1 ? "s" : ""}
        </Btn>
      </div>
    </Modal>
  );
}

function PaymentMilestonesModal({ doc, docType, onSave, onClose }) {
  const [milestones, setMilestones] = useState(
    Array.isArray(doc.paymentMilestones) && doc.paymentMilestones.length > 0
      ? doc.paymentMilestones
      : []
  );

  const total = doc.total || 0;
  const scheduledTotal = milestones.reduce((sum, m) => sum + (parseFloat(m.amount) || 0), 0);
  const remaining = Math.round((total - scheduledTotal) * 100) / 100;

  function updateMilestone(idx, field, value) {
    const updated = [...milestones];
    updated[idx] = { ...updated[idx], [field]: value };
    setMilestones(updated);
  }

  function handleSave() {
    // Store amounts as numbers, drop entirely-blank rows
    const cleaned = milestones
      .map((m) => ({ ...m, amount: parseFloat(m.amount) || 0 }))
      .filter((m) => m.amount > 0 || m.due);
    onSave(doc, cleaned);
    onClose();
  }

  return (
    <Modal onClose={onClose}>
      <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 16px", fontSize: 19 }}>
        Payment Milestones — {doc.number}
      </h3>

      <div style={{ background: "#f6f1e7", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span>Total amount:</span>
          <strong>{fmtMoney(total, "AUD")}</strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span>Scheduled across {milestones.length} payment{milestones.length !== 1 ? "s" : ""}:</span>
          <strong>{fmtMoney(scheduledTotal, "AUD")}</strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", color: remaining !== 0 ? "#a3442e" : "#5c7a4f" }}>
          <span>Unscheduled remainder:</span>
          <strong>{fmtMoney(remaining, "AUD")}</strong>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h4 style={{ fontSize: 13, fontWeight: 600, color: "#4a3527", margin: 0 }}>Payments</h4>
        <Btn
          variant="ghost"
          size="sm"
          onClick={() => setMilestones([...milestones, { due: "", amount: "", paid: false, paidDate: "" }])}
        >
          + Add payment
        </Btn>
      </div>

      {milestones.length === 0 ? (
        <p style={{ fontSize: 12, color: "#8a7a66", margin: "0 0 16px" }}>
          No payment milestones yet — could be 1, 2, 3 or more. Click "Add payment" to create the first one.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
          {milestones.map((m, idx) => (
            <div key={idx} style={{ background: "#f9f7f2", border: "1px solid #e3d8c6", borderRadius: 8, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <h5 style={{ fontSize: 13, fontWeight: 600, color: "#4a3527", margin: 0 }}>Payment {idx + 1}</h5>
                <button
                  type="button"
                  onClick={() => setMilestones(milestones.filter((_, i) => i !== idx))}
                  style={{ fontSize: 16, background: "none", border: "none", color: "#a3442e", cursor: "pointer" }}
                  title="Remove"
                >
                  ×
                </button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                <Field label="Due">
                  <input
                    style={{ ...inputStyle, width: "100%", maxWidth: "100%" }}
                    type="date"
                    value={m.due || ""}
                    onChange={(e) => updateMilestone(idx, "due", e.target.value)}
                  />
                </Field>
                <Field label="Amount (AUD)">
                  <input
                    style={{ ...inputStyle, width: "100%", maxWidth: "100%" }}
                    type="number"
                    step="0.01"
                    min="0"
                    value={m.amount}
                    onChange={(e) => updateMilestone(idx, "amount", e.target.value)}
                  />
                </Field>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Field label="Paid">
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={m.paid || false}
                      onChange={(e) => {
                        updateMilestone(idx, "paid", e.target.checked);
                        // Auto-fill paid date with due date when marked as paid
                        if (e.target.checked && m.due) {
                          updateMilestone(idx, "paidDate", m.due);
                        }
                      }}
                    />
                    <span style={{ fontSize: 13 }}>Marked as paid</span>
                  </label>
                </Field>
                {m.paid && (
                  <Field label="Paid date">
                    <input
                      style={{ ...inputStyle, width: "100%", maxWidth: "100%" }}
                      type="date"
                      value={m.paidDate || ""}
                      onChange={(e) => updateMilestone(idx, "paidDate", e.target.value)}
                    />
                  </Field>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <Btn variant="ghost" onClick={onClose}>
          Cancel
        </Btn>
        <Btn variant="primary" onClick={handleSave}>
          Save milestones
        </Btn>
      </div>
    </Modal>
  );
}

/* ============================================================
   CONTACTS TAB (Suppliers & Customers)
   ============================================================ */


// Hook: detect mobile viewport
function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = React.useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  React.useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [breakpoint]);
  return isMobile;
}

function ContactsTab({ kind, db, update, showToast, nextNumber, pendingOpen, clearPendingOpen, openRecord }) {
  const isSupplier = kind === "supplier";
  
  // Move all hooks to TOP, before any conditional returns (React Hook Rules)
  const [search, setSearch] = useState("");
  const [editingContact, setEditingContact] = useState(undefined);
  const [importData, setImportData] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [loggingActivityFor, setLoggingActivityFor] = useState(null);
  const isMobile = useIsMobile();

  // Keep the open contact modal in sync with the latest data (e.g. a customer's
  // last_quote_number/last_quote_value can change from quote acceptance while
  // their record happens to be open) — same fix applied to Prospects.
  useEffect(() => {
    if (!editingContact || !db) return;
    const coll = isSupplier ? db.suppliers : db.customers;
    const fresh = (coll || []).find((c) => c.id === editingContact.id);
    if (fresh && fresh !== editingContact) setEditingContact(fresh);
  }, [db]);

  // Cross-tab navigation: open a specific customer/supplier if asked.
  useEffect(() => {
    if (!pendingOpen || !db) return;
    const wants = (pendingOpen.type === "supplier" && isSupplier) || (pendingOpen.type === "customer" && !isSupplier);
    if (!wants) return;
    const found = (isSupplier ? db.suppliers : db.customers || []).find((c) => c.id === pendingOpen.id);
    if (found) setEditingContact(found);
    clearPendingOpen();
  }, [pendingOpen, db, isSupplier]);
  
  if (!db || (!isSupplier && !db.customers) || (isSupplier && !db.suppliers)) {
    return (
      <section>
        <h2 className="section-title">{isSupplier ? "Suppliers" : "Customers"}</h2>
        <p className="section-desc">Loading data...</p>
      </section>
    );
  }

  const collection = isSupplier ? db.suppliers : db.customers;

  function handleImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const csvText = event.target?.result;
        const rows = parseCSV(csvText);
        if (rows.length === 0) {
          showToast("CSV file is empty");
          return;
        }

        const validRows = rows
          .map((row) => ({
            name: row.name?.trim(),
            ...(isSupplier && { contactPerson: row.contactPerson?.trim() || "" }),
            email: row.email?.trim() || "",
            phone: row.phone?.trim() || "",
            address: {
              street: row.street?.trim() || "",
              suburb: row.suburb?.trim() || "",
              state: row.state?.trim() || "QLD",
              postcode: row.postcode?.trim() || "",
            },
            ...(isSupplier && {
              bankAccount: {
                name: row.bankAccountName?.trim() || "",
                bsb: row.bankAccountBSB?.trim() || "",
                account: row.bankAccountNumber?.trim() || "",
              },
            }),
            ...(!isSupplier && { product: row.product?.trim() || "" }),
            notes: row.notes?.trim() || "",
          }))
          .filter((row) => row.name);

        if (validRows.length === 0) {
          showToast("No valid records found in CSV");
          return;
        }

        setImportData({
          type: isSupplier ? "supplier" : "customer",
          rows: validRows,
          fileName: file.name,
        });
      } catch (err) {
        showToast("Error parsing CSV: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  function confirmImport() {
    if (!importData) return;

    // Save to Supabase FIRST, then update local state
    (async () => {
      try {
        const table = isSupplier ? "suppliers" : "customers";
        const savedRows = [];
        
        for (const row of importData.rows) {
          try {
            // id column is a real uuid type — a client-generated string like "sup_xxxxx"
            // or "cus_xxxxx" is rejected by Postgres. Let it generate the real UUID,
            // matching the pattern already used by saveContact.
            const createPayload = toSupabaseFormat({ ...row }, table);
            delete createPayload.id;
            const result = await supabaseREST("POST", table, createPayload);
            const savedRow = Array.isArray(result) ? result[0] : result;
            savedRows.push(savedRow);
            console.log(`✅ Saved ${isSupplier ? "supplier" : "customer"}: ${row.name}`);
          } catch (rowErr) {
            console.error(`❌ Failed to save ${row.name}:`, rowErr);
          }
        }
        
        // Now update local state with the rows Supabase actually returned (real ids),
        // not the client-side draft objects.
        update((next) => {
          const coll = isSupplier ? next.suppliers : next.customers;
          savedRows.forEach((row) => {
            const converted = fromSupabaseFormat(row, table);
            const exists = coll.find((c) => c.name.toLowerCase() === converted.name.toLowerCase());
            if (!exists) {
              coll.push(converted);
            }
          });
        });

        showToast(`Imported ${savedRows.length} ${isSupplier ? "supplier" : "customer"}(s) to Supabase`);
        setImportData(null);
      } catch (err) {
        console.error("Import error:", err);
        showToast(`Error importing: ${err.message}`);
      }
    })();
  }

  let list = collection.slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  // Archived customers are hidden from the plain list by default, but still
  // findable — as soon as a search term is typed, archived customers are
  // included in the results too. Suppliers don't have this field.
  if (!isSupplier && !search) {
    list = list.filter((c) => !c.archived);
  }
  if (search) {
    const s = search.toLowerCase();
    list = list.filter((c) => {
      const haystack = [
        c.name,
        c.email,
        c.phone,
        c.contactPerson,
        c.notes,
        c.product,
        c.status,
        c.source,
        c.invoiceNumber,
        c.lastQuoteNumber,
        c.address?.street,
        c.address?.suburb,
        c.address?.state,
        c.address?.postcode,
        c.bankAccount?.name,
        c.bankAccount?.bsb,
        c.bankAccount?.account,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(s);
    });
  }

  function saveContact(payload, editing) {
    // Save to Supabase first, then update local state
    (async () => {
      try {
        const table = isSupplier ? "suppliers" : "customers";
        
        if (editing) {
          // Convert to Supabase format and PATCH (WITHOUT updatedAt since column doesn't exist)
          const updatePayload = toSupabaseFormat(payload, table);
          const result = await supabaseREST("PATCH", `${table}?id=eq.${editing.id}`, updatePayload);
          // Use the full returned row to update local state so JSONB fields
          // like `activities` that aren't part of the form payload are preserved.
          const savedRow = Array.isArray(result) && result[0] ? result[0] : null;
          // Update local state (keep original payload structure)
          update((next) => {
            const coll = isSupplier ? next.suppliers : next.customers;
            const target = coll.find((c) => c.id === editing.id);
            if (target) {
              if (savedRow) {
                Object.assign(target, fromSupabaseFormat(savedRow, table));
              } else {
                const existing = { activities: target.activities, attachments: target.attachments };
                Object.assign(target, payload, existing);
              }
            }
          });
          showToast("Contact updated");
        } else {
          // Create new contact in Supabase — let Postgres generate the real UUID.
          // (id column is uuid type; a client-generated string like "sup_xxxxx" is rejected.)
          const createPayload = toSupabaseFormat(payload, table);
          delete createPayload.id;
          const result = await supabaseREST("POST", table, createPayload);
          const savedRow = Array.isArray(result) ? result[0] : result;
          const newContact = { ...payload, ...fromSupabaseFormat(savedRow, table), id: savedRow.id };

          // Update local state with the Supabase-generated id
          update((next) => {
            const coll = isSupplier ? next.suppliers : next.customers;
            coll.push(newContact);
          });
          showToast("Contact added");
        }
        setEditingContact(undefined);
      } catch (err) {
        showToast(`Error saving contact: ${err.message}`);
        console.error("Save contact error:", err);
      }
    })();
  }

  function deleteContact(contact) {
    setPendingDelete(contact);
  }

  // Archive is a soft-hide, not a delete: the record stays in Supabase and
  // still shows up when actively searching, but disappears from the default
  // customer list. Only applies to customers (suppliers don't have this).
  function archiveContact(contact, archived) {
    (async () => {
      try {
        await supabaseREST("PATCH", `customers?id=eq.${contact.id}`, { is_archived: archived });
        update((next) => {
          const target = next.customers.find((c) => c.id === contact.id);
          if (target) target.archived = archived;
        });
        showToast(archived ? "Customer archived" : "Customer restored");
      } catch (err) {
        showToast(`Error ${archived ? "archiving" : "restoring"} customer: ${err.message}`);
        console.error("Archive contact error:", err);
      }
    })();
  }

  function logCustomerActivity(contact, activity) {
    (async () => {
      try {
        const newActivity = {
          id: uid("act"),
          date: activity.date,
          type: activity.type,
          notes: activity.notes,
          createdAt: todayISO(),
        };
        const updatedActivities = [...(contact.activities || []), newActivity];
        // Use supabaseREST directly (not schema fallback) so a missing `activities`
        // column produces a visible error rather than silently dropping the data.
        await supabaseREST("PATCH", `customers?id=eq.${contact.id}`, { activities: updatedActivities });
        update((next) => {
          const target = next.customers.find((c) => c.id === contact.id);
          if (target) target.activities = updatedActivities;
        });
        // Refresh the open modal so activities appear immediately
        setEditingContact((prev) =>
          prev && prev.id === contact.id ? { ...prev, activities: updatedActivities } : prev
        );
        setLoggingActivityFor(null);
        showToast("Activity logged");
      } catch (err) {
        showToast(`Error logging activity: ${err.message}`);
        console.error("Log customer activity error:", err);
      }
    })();
  }

  function editCustomerActivity(contact, index, activityData) {
    (async () => {
      try {
        const updatedActivities = (contact.activities || []).map((a, i) =>
          i === index ? { ...a, date: activityData.date, type: activityData.type, notes: activityData.notes } : a
        );
        await supabaseREST("PATCH", `customers?id=eq.${contact.id}`, { activities: updatedActivities });
        update((next) => {
          const target = next.customers.find((c) => c.id === contact.id);
          if (target) target.activities = updatedActivities;
        });
        setEditingContact((prev) =>
          prev && prev.id === contact.id ? { ...prev, activities: updatedActivities } : prev
        );
        setLoggingActivityFor(null);
        showToast("Activity updated");
      } catch (err) {
        showToast(`Error updating activity: ${err.message}`);
        console.error("Edit customer activity error:", err);
      }
    })();
  }

  function deleteCustomerActivity(contact, index) {
    (async () => {
      try {
        const updatedActivities = (contact.activities || []).filter((_, i) => i !== index);
        await supabaseREST("PATCH", `customers?id=eq.${contact.id}`, { activities: updatedActivities });
        update((next) => {
          const target = next.customers.find((c) => c.id === contact.id);
          if (target) target.activities = updatedActivities;
        });
        setEditingContact((prev) =>
          prev && prev.id === contact.id ? { ...prev, activities: updatedActivities } : prev
        );
        setLoggingActivityFor(null);
        showToast("Activity deleted");
      } catch (err) {
        showToast(`Error deleting activity: ${err.message}`);
        console.error("Delete customer activity error:", err);
      }
    })();
  }

  function createQuoteFromCustomer(customer) {
    (async () => {
      try {
        const number = nextNumber("quote", db);
        const newQuoteLocal = {
          number,
          status: "Draft",
          party: customer.name,
          model: customer.product || "",
          date: todayISO(),
          contact: customer.email || customer.phone || "",
          notes: "",
          discount: 0,
          lines: [],
          subtotal: 0,
          gst: 0,
          total: 0,
          grossProfitPct: null,
          fxRateUsed: db.fx ? db.fx.usdAudRate : 1.55,
          createdAt: todayISO(),
        };
        const createPayload = toSupabaseFormat(newQuoteLocal, "quotes");
        delete createPayload.id;
        const result = await supabaseRESTWithSchemaFallback("POST", "quotes", createPayload);
        const savedRow = Array.isArray(result) ? result[0] : result;
        const newQuote = { ...newQuoteLocal, ...fromSupabaseFormat(savedRow, "quotes"), id: savedRow.id };
        update((next) => { next.quotes.push(newQuote); });
        showToast("Quote created for " + customer.name);
        if (openRecord) openRecord("quote", newQuote.id);
      } catch (err) {
        showToast(`Error creating quote: ${err.message}`);
        console.error("Create quote from customer error:", err);
      }
    })();
  }

  return (
    <section>
      <div className="toolbar-row">
        <div>
          <h2 className="section-title">{isSupplier ? "Suppliers" : "Customers"}</h2>
          <p className="section-desc">
            {isSupplier
              ? "Manage your supplier contact details, bank accounts, and notes."
              : "Manage your customer and prospect contact details."}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="secondary" onClick={() => document.getElementById(`contacts-import-input-${kind}`)?.click()}>
            ⬆ Import CSV
          </Btn>
          <Btn variant="primary" onClick={() => setEditingContact(null)}>
            + Add {isSupplier ? "supplier" : "customer"}
          </Btn>
          <input
            id={`contacts-import-input-${kind}`}
            type="file"
            accept=".csv"
            onChange={handleImportFile}
            style={{ display: "none" }}
          />
        </div>
      </div>

      <Panel>
        <input
          style={{ ...inputStyle, marginBottom: !isSupplier ? 4 : 14 }}
          type="text"
          placeholder="Search name, email, phone, notes, address…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {!isSupplier && (
          <p style={{ fontSize: 11, color: "#8a7a66", margin: "0 0 14px" }}>
            Archived customers are hidden here by default, but will show up (marked "ARCHIVED") if your search matches them.
          </p>
        )}

        {list.length === 0 ? (
          <Empty
            icon="📇"
            text={`No ${isSupplier ? "suppliers" : "customers"} yet. Add one to get started.`}
          />
        ) : isMobile ? (
          // ── Mobile: name-only tappable list — opens directly editable ──
          <div style={{ display: "flex", flexDirection: "column" }}>
            {list.map((c) => (
              <button
                key={c.id}
                onClick={() => setEditingContact(c)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "13px 4px", background: "none", border: "none",
                  borderBottom: "1px solid #f0e8d9", cursor: "pointer", textAlign: "left", width: "100%",
                }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#4a3527" }}>
                    {c.name}
                    {c.archived && (
                      <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: "#a3442e", background: "#fbeae5", padding: "2px 6px", borderRadius: 5 }}>
                        ARCHIVED
                      </span>
                    )}
                  </div>
                  {!isSupplier && c.product && <div style={{ fontSize: 12, color: "#8a7a66", marginTop: 2 }}>{c.product}</div>}
                  {isSupplier && c.contactPerson && <div style={{ fontSize: 12, color: "#8a7a66", marginTop: 2 }}>{c.contactPerson}</div>}
                </div>
                <span style={{ color: "#b5552b", fontSize: 16 }}>›</span>
              </button>
            ))}
          </div>
        ) : (
          // ── Desktop: full table — click anywhere on the row to open the
          // record, already editable — no separate view/edit step. ──
          <table>
            <thead>
              <tr>
                <th>Name</th>
                {isSupplier && <th>Contact</th>}
                <th>Email</th>
                <th>Phone</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} onClick={() => setEditingContact(c)} style={{ cursor: "pointer" }}>
                  <td>
                    <strong>{c.name}</strong>
                    {c.archived && (
                      <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: "#a3442e", background: "#fbeae5", padding: "2px 6px", borderRadius: 5 }}>
                        ARCHIVED
                      </span>
                    )}
                    {c.notes && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{c.notes.substring(0, 60)}</div>}
                  </td>
                  {isSupplier && <td className="muted">{c.contactPerson || "—"}</td>}
                  <td className="muted">{c.email || "—"}</td>
                  <td className="muted">{c.phone || "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteContact(c);
                      }}
                      title="Delete"
                      style={{ background: "none", border: "none", color: "#a3442e", cursor: "pointer", fontSize: 16, padding: 4 }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {editingContact !== undefined && (
        <ContactModal
          kind={kind}
          editing={editingContact}
          onCancel={() => setEditingContact(undefined)}
          onSave={saveContact}
          onCreateQuote={!isSupplier ? createQuoteFromCustomer : undefined}
          onArchive={!isSupplier ? (contact, archived) => { archiveContact(contact, archived); setEditingContact(undefined); } : undefined}
          onLogActivity={!isSupplier ? () => setLoggingActivityFor({ contact: editingContact, activity: null, index: null }) : undefined}
          onEditActivity={!isSupplier ? (activity, index) => setLoggingActivityFor({ contact: editingContact, activity, index }) : undefined}
          db={db}
          openRecord={openRecord}
        />
      )}

      {importData && (
        <Modal onClose={() => setImportData(null)}>
          <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 16px", fontSize: 19 }}>
            Import {importData.rows.length} {importData.type}{importData.rows.length !== 1 ? "s" : ""}
          </h3>
          <p style={{ color: "#6b5240", fontSize: 13, margin: "0 0 14px" }}>
            File: <strong>{importData.fileName}</strong>
          </p>

          <div style={{ background: "#f9f7f2", border: "1px solid #d3c9b8", borderRadius: 8, padding: 12, marginBottom: 14, maxHeight: 300, overflowY: "auto" }}>
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #d3c9b8" }}>
                  <th style={{ textAlign: "left", padding: "6px 0", fontWeight: 600, color: "#4a3527" }}>Name</th>
                  {isSupplier && <th style={{ textAlign: "left", padding: "6px 0", fontWeight: 600, color: "#4a3527" }}>Contact</th>}
                  <th style={{ textAlign: "left", padding: "6px 0", fontWeight: 600, color: "#4a3527" }}>Email</th>
                </tr>
              </thead>
              <tbody>
                {importData.rows.map((row, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #e3d8c6" }}>
                    <td style={{ padding: "6px 0" }}>{row.name}</td>
                    {isSupplier && <td style={{ padding: "6px 0", color: "#8a7a66", fontSize: 11 }}>{row.contactPerson || "—"}</td>}
                    <td style={{ padding: "6px 0", color: "#8a7a66", fontSize: 11 }}>{row.email || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <Btn variant="ghost" onClick={() => setImportData(null)}>
              Cancel
            </Btn>
            <Btn variant="primary" onClick={confirmImport}>
              Import {importData.rows.length} {importData.type}{importData.rows.length !== 1 ? "s" : ""}
            </Btn>
          </div>
        </Modal>
      )}

      {loggingActivityFor && (
        <ActivityLogModal
          prospect={loggingActivityFor.contact}
          activity={loggingActivityFor.activity}
          onCancel={() => setLoggingActivityFor(null)}
          onSave={(activityData) => {
            if (loggingActivityFor.activity) {
              editCustomerActivity(loggingActivityFor.contact, loggingActivityFor.index, activityData);
            } else {
              logCustomerActivity(loggingActivityFor.contact, activityData);
            }
          }}
          onDelete={
            loggingActivityFor.activity
              ? () => deleteCustomerActivity(loggingActivityFor.contact, loggingActivityFor.index)
              : null
          }
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title={`Delete ${isSupplier ? "supplier" : "customer"}?`}
          message={`Delete "${pendingDelete.name}"? This action cannot be undone.`}
          confirmLabel="Delete"
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            try {
              // Delete from Supabase first
              const table = isSupplier ? "suppliers" : "customers";
              console.log(`🗑️ Deleting ${table} ${pendingDelete.id} from Supabase`);
              await supabaseREST("DELETE", table, null, `id=eq.${pendingDelete.id}`);
              console.log(`✅ Successfully deleted ${table} ${pendingDelete.id} from Supabase`);
              
              // Then update local state
              update((next) => {
                const coll = isSupplier ? next.suppliers : next.customers;
                const idx = coll.findIndex((c) => c.id === pendingDelete.id);
                if (idx >= 0) coll.splice(idx, 1);
              });
              showToast(`${isSupplier ? "Supplier" : "Customer"} deleted`);
            } catch (err) {
              console.error("Delete error:", err);
              showToast(`❌ Failed to delete: ${err.message}`);
            } finally {
              setPendingDelete(null);
            }
          }}
        />
      )}
    </section>
  );
}


// ---- Attachments Panel ----
function AttachmentsPanel({ recordId, recordType, attachments, onAttachmentsChange }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const bucket = "attachments";

  async function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const path = `${recordType}/${recordId}/${Date.now()}_${file.name}`;
      const url = await uploadAttachment(bucket, path, file);
      const newAttachment = { name: file.name, url, path, uploadedAt: new Date().toISOString() };
      const updated = [...(attachments || []), newAttachment];
      onAttachmentsChange(updated);
    } catch (err) {
      setError(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function handleDelete(att) {
    try {
      await deleteAttachment(bucket, att.path);
      onAttachmentsChange((attachments || []).filter(a => a.path !== att.path));
    } catch (err) {
      setError(`Delete failed: ${err.message}`);
    }
  }

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <label style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "5px 12px", background: "#d4a574", color: "#fff",
          borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer",
          opacity: uploading ? 0.6 : 1,
        }}>
          {uploading ? "Uploading…" : "＋ Add file"}
          <input type="file" style={{ display: "none" }} onChange={handleFileChange} disabled={uploading} />
        </label>
        <span style={{ fontSize: 11, color: "#8a7a66" }}>PDF, images, Word docs, etc.</span>
      </div>
      {error && <p style={{ fontSize: 12, color: "#a3442e", margin: "0 0 8px" }}>{error}</p>}
      {(attachments || []).length === 0 ? (
        <p style={{ fontSize: 12, color: "#aaa", margin: 0 }}>No attachments yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(attachments || []).map((att, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "#f9f5f0", borderRadius: 4, border: "1px solid #e3d8c6" }}>
              <a href={att.url} target="_blank" rel="noopener noreferrer" style={{ flex: 1, fontSize: 12, color: "#b5552b", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                📎 {att.name}
              </a>
              <span style={{ fontSize: 11, color: "#aaa", whiteSpace: "nowrap" }}>
                {att.uploadedAt ? new Date(att.uploadedAt).toLocaleDateString("en-AU") : ""}
              </span>
              <button onClick={() => handleDelete(att)} style={{ background: "none", border: "none", color: "#a3442e", cursor: "pointer", fontSize: 14, padding: 0 }}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ContactModal({ kind, editing, onCancel, onSave, onCreateQuote, onArchive, onLogActivity, onEditActivity, db, openRecord }) {
  const isSupplier = kind === "supplier";
  const [name, setName] = useState(editing ? editing.name : "");
  const [contactPerson, setContactPerson] = useState(isSupplier ? (editing ? editing.contactPerson || "" : "") : "");
  const [email, setEmail] = useState(editing ? String(editing.email || "") : "");
  const [phone, setPhone] = useState(editing ? String(editing.phone || "") : "");
  const [street, setStreet] = useState(String(editing?.address?.street || ""));
  const [suburb, setSuburb] = useState(String(editing?.address?.suburb || ""));
  const [state, setState] = useState(editing?.address?.state || "QLD");
  const [postcode, setPostcode] = useState(String(editing?.address?.postcode || ""));
  const [bankAccountName, setBankAccountName] = useState(String(editing?.bankAccount?.name || ""));
  const [bsb, setBsb] = useState(String(editing?.bankAccount?.bsb || ""));
  const [accountNumber, setAccountNumber] = useState(String(editing?.bankAccount?.account || ""));
  const [invoiceNumber, setInvoiceNumber] = useState(!isSupplier ? String(editing?.invoiceNumber || "") : "");
  // Customer status dropdown. Existing Supabase data has values like "Deposit" and
  // "Delivered" already; normalise casing so an existing record pre-selects
  // correctly even if it was entered inconsistently (e.g. "delivered" vs "Delivered").
  const CUSTOMER_STATUS_OPTIONS = ["Deposit", "Paid", "Delivered", "Canceled"];
  const normalizedExistingStatus = editing?.status
    ? CUSTOMER_STATUS_OPTIONS.find((o) => o.toLowerCase() === String(editing.status).toLowerCase())
    : null;
  const [status, setStatus] = useState(!isSupplier ? normalizedExistingStatus || editing?.status || "Deposit" : "");
  const [invoices, setInvoices] = useState(!isSupplier ? (editing?.invoices || []) : []);
  const [lastQuoteNumber, setLastQuoteNumber] = useState(!isSupplier ? String(editing?.lastQuoteNumber || "") : "");
  const [lastQuoteValue, setLastQuoteValue] = useState(!isSupplier ? String(editing?.lastQuoteValue || "") : "");
  const [notes, setNotes] = useState(editing ? editing.notes || "" : "");
  const [attachments, setAttachments] = useState(editing ? editing.attachments || [] : []);
  const [error, setError] = useState("");

  function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Please enter a name.");
      return;
    }
    onSave(
      {
        name: trimmedName,
        ...(isSupplier && { contactPerson: contactPerson.trim() }),
        email: email.trim(),
        phone: phone.trim(),
        address: { street: street.trim(), suburb: suburb.trim(), state, postcode: postcode.trim() },
        ...(isSupplier && { bankAccount: { name: bankAccountName.trim(), bsb: bsb.trim(), account: accountNumber.trim() } }),
        ...(!isSupplier && invoiceNumber && { invoiceNumber: invoiceNumber.trim() }),
        ...(!isSupplier && { status }),
        ...(!isSupplier && { invoices: invoices.filter(inv => inv.amount || inv.invoiceMonth) }),
        ...(!isSupplier && lastQuoteNumber && { lastQuoteNumber: lastQuoteNumber.trim() }),
        ...(!isSupplier && lastQuoteValue && { lastQuoteValue: parseFloat(lastQuoteValue) || 0 }),
        notes: notes.trim(),
        attachments,
      },
      editing
    );
  }

  // Find quotes/POs linked to this contact. Quotes prefer the proper ID-based
  // link (customerId) — reliable even if the name is edited later — falling
  // back to name-matching only for older quotes that predate that link and
  // haven't been backfilled via "Link quotes to customers" yet. POs now have
  // the same ID-based link (supplierId) for the supplier side.
  const linkedQuotes =
    editing && db
      ? (db.quotes || []).filter(
          (q) =>
            q.customerId === editing.id ||
            (!q.customerId && q.party && q.party.trim().toLowerCase() === editing.name.trim().toLowerCase())
        )
      : [];
  const linkedPOs =
    editing && db
      ? (db.pos || []).filter((p) => {
          if (isSupplier) {
            return (
              p.supplierId === editing.id ||
              (!p.supplierId && p.party && p.party.trim().toLowerCase() === editing.name.trim().toLowerCase())
            );
          }
          // Customer side of a PO is still name-matched only (no ID link built for that yet).
          return p.customer && p.customer.trim().toLowerCase() === editing.name.trim().toLowerCase();
        })
      : [];

  return (
    <Modal onClose={onCancel}>
      <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 12px", fontSize: 19 }}>
        {editing ? `Edit ${isSupplier ? "supplier" : "customer"}` : `Add ${isSupplier ? "supplier" : "customer"}`}
        {editing?.archived && (
          <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 700, color: "#a3442e", background: "#fbeae5", padding: "3px 8px", borderRadius: 6, verticalAlign: "middle" }}>
            ARCHIVED
          </span>
        )}
      </h3>

      {editing && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          {onLogActivity && (
            <Btn variant="ghost" size="sm" onClick={onLogActivity}>Log activity</Btn>
          )}
          {onCreateQuote && (
            <Btn variant="ghost" size="sm" onClick={() => onCreateQuote(editing)}>Create quote</Btn>
          )}
          {onArchive && (
            <Btn
              variant="ghost"
              size="sm"
              onClick={() => onArchive(editing, !editing.archived)}
              style={editing.archived ? { color: "#5c7a4f" } : { color: "#a3442e" }}
            >
              {editing.archived ? "Restore customer" : "Archive customer"}
            </Btn>
          )}
        </div>
      )}

      <Field label="Name (required)">
        <input style={inputStyle} type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <div className="grid2">
        {isSupplier && (
          <Field label="Contact person">
            <input style={inputStyle} type="text" value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} />
          </Field>
        )}
        <Field label="Email">
          <input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>

      <Field label="Phone">
        <input style={inputStyle} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>

      {editing && (linkedQuotes.length > 0 || linkedPOs.length > 0) && (
        <div style={{ borderTop: "1px solid #e3d8c6", paddingTop: 14, marginTop: 14 }}>
          <h4 style={{ fontSize: 13, fontWeight: 600, color: "#6b5240", margin: "0 0 10px" }}>
            {isSupplier ? "Linked purchase orders" : "Linked quotes & purchase orders"}
          </h4>
          {linkedQuotes.length > 0 && (
            <div style={{ marginBottom: linkedPOs.length > 0 ? 10 : 0 }}>
              {linkedQuotes.map((q) => (
                <div
                  key={q.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 12,
                    padding: "6px 10px",
                    background: "#f9f7f2",
                    border: "1px solid #e3d8c6",
                    borderRadius: 6,
                    marginBottom: 6,
                  }}
                >
                  <span>
                    Quote #{q.number} · {fmtDate(q.createdAt || q.date)} · {q.model || "—"} · {fmtMoney(q.total || 0, "AUD")}
                  </span>
                  {openRecord && (
                    <Btn variant="text" size="sm" onClick={() => openRecord("quote", q.id)}>
                      View →
                    </Btn>
                  )}
                </div>
              ))}
            </div>
          )}
          {linkedPOs.length > 0 && (
            <div>
              {linkedPOs.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 12,
                    padding: "6px 10px",
                    background: "#f9f7f2",
                    border: "1px solid #e3d8c6",
                    borderRadius: 6,
                    marginBottom: 6,
                  }}
                >
                  <span>
                    PO #{p.number} · {fmtDate(p.createdAt || p.date)} · {fmtMoney(p.total || 0, "AUD")}
                  </span>
                  {openRecord && (
                    <Btn variant="text" size="sm" onClick={() => openRecord("po", p.id)}>
                      View →
                    </Btn>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!isSupplier && (
        <div style={{ borderTop: "1px solid #e3d8c6", paddingTop: 14, marginTop: 14 }}>
          <h4 style={{ fontSize: 13, fontWeight: 600, color: "#6b5240", margin: "0 0 10px" }}>Invoice information</h4>
          <div className="grid2" style={{ marginBottom: 10 }}>
            <Field label="Invoice number">
              <input
                style={inputStyle}
                type="text"
                placeholder="e.g. INV-001"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
              />
            </Field>
            <Field label="Status">
              <select style={inputStyle} value={status} onChange={(e) => setStatus(e.target.value)}>
                {CUSTOMER_STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: "#6b5240", margin: 0 }}>Payment schedule</p>
              <button
                type="button"
                onClick={() => setInvoices([...invoices, { amount: "", invoiceMonth: "" }])}
                style={{ fontSize: 11, padding: "3px 10px", background: "#d4a574", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}
              >
                + Add payment
              </button>
            </div>
            {invoices.length === 0 && (
              <p style={{ fontSize: 12, color: "#8a7a66", margin: 0 }}>No payments recorded yet.</p>
            )}
            {invoices.map((inv, idx) => (
              <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, marginBottom: 6, alignItems: "end" }}>
                <Field label={`Invoice ${idx + 1} amount (AUD)`}>
                  <input
                    style={inputStyle}
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="e.g. 37000"
                    value={inv.amount}
                    onChange={(e) => {
                      const updated = [...invoices];
                      updated[idx] = { ...updated[idx], amount: e.target.value };
                      setInvoices(updated);
                    }}
                  />
                </Field>
                <Field label="Month (YYYY-MM)">
                  <input
                    style={inputStyle}
                    type="month"
                    value={inv.invoiceMonth}
                    onChange={(e) => {
                      const updated = [...invoices];
                      updated[idx] = { ...updated[idx], invoiceMonth: e.target.value };
                      setInvoices(updated);
                    }}
                  />
                </Field>
                <button
                  type="button"
                  onClick={() => setInvoices(invoices.filter((_, i) => i !== idx))}
                  style={{ fontSize: 16, background: "none", border: "none", color: "#a3442e", cursor: "pointer", paddingBottom: 6 }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {!isSupplier && (
        <div style={{ borderTop: "1px solid #e3d8c6", paddingTop: 14, marginTop: 14 }}>
          <h4 style={{ fontSize: 13, fontWeight: 600, color: "#6b5240", margin: "0 0 10px" }}>Quote tracking</h4>
          <p style={{ fontSize: 12, color: "#8a7a66", margin: "0 0 10px" }}>Last accepted quote information (auto-updated when quote is accepted)</p>
          <div className="grid2">
            <Field label="Last quote #">
              <input
                style={inputStyle}
                type="text"
                placeholder="e.g. Q-2"
                value={lastQuoteNumber}
                onChange={(e) => setLastQuoteNumber(e.target.value)}
              />
            </Field>
            <Field label="Quote value (AUD)">
              <input
                style={inputStyle}
                type="number"
                step="0.01"
                min="0"
                value={lastQuoteValue}
                onChange={(e) => setLastQuoteValue(e.target.value)}
              />
            </Field>
          </div>
        </div>
      )}

      <div style={{ borderTop: "1px solid #e3d8c6", paddingTop: 14, marginTop: 14 }}>
        <h4 style={{ fontSize: 13, fontWeight: 600, color: "#6b5240", margin: "0 0 10px" }}>Address</h4>
        <Field label="Street">
          <input style={inputStyle} type="text" value={street} onChange={(e) => setStreet(e.target.value)} />
        </Field>
        <div className="grid2">
          <Field label="Suburb">
            <input style={inputStyle} type="text" value={suburb} onChange={(e) => setSuburb(e.target.value)} />
          </Field>
          <Field label="State">
            <select style={inputStyle} value={state} onChange={(e) => setState(e.target.value)}>
              <option value="QLD">QLD</option>
              <option value="NSW">NSW</option>
              <option value="VIC">VIC</option>
              <option value="TAS">TAS</option>
              <option value="SA">SA</option>
              <option value="WA">WA</option>
              <option value="NT">NT</option>
              <option value="ACT">ACT</option>
            </select>
          </Field>
          <Field label="Postcode">
            <input style={inputStyle} type="text" value={postcode} onChange={(e) => setPostcode(e.target.value)} />
          </Field>
        </div>
      </div>

      {isSupplier && (
        <div style={{ borderTop: "1px solid #e3d8c6", paddingTop: 14, marginTop: 14 }}>
          <h4 style={{ fontSize: 13, fontWeight: 600, color: "#6b5240", margin: "0 0 10px" }}>Bank account</h4>
          <Field label="Account name">
            <input style={inputStyle} type="text" value={bankAccountName} onChange={(e) => setBankAccountName(e.target.value)} />
          </Field>
          <div className="grid2">
            <Field label="BSB">
              <input style={inputStyle} type="text" placeholder="XXX-XXX" value={bsb} onChange={(e) => setBsb(e.target.value)} />
            </Field>
            <Field label="Account number">
              <input style={inputStyle} type="text" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} />
            </Field>
          </div>
        </div>
      )}

      <Field label="Notes">
        <textarea
          style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>

      {editing && !isSupplier && (
        <div style={{ borderTop: "1px solid #e3d8c6", paddingTop: 14, marginTop: 14 }}>
          <h4 style={{ fontSize: 13, fontWeight: 600, color: "#6b5240", margin: "0 0 10px" }}>Attachments</h4>
          <AttachmentsPanel
            recordId={editing.id}
            recordType="customers"
            attachments={attachments}
            onAttachmentsChange={setAttachments}
          />
        </div>
      )}

      {editing && !isSupplier && (
        <div style={{ borderTop: "1px solid #e3d8c6", paddingTop: 14, marginTop: 14 }}>
          <h4 style={{ fontSize: 13, fontWeight: 600, color: "#6b5240", margin: "0 0 10px" }}>
            Activity timeline ({(editing.activities || []).length})
          </h4>
          {(editing.activities || []).length === 0 ? (
            <p className="muted" style={{ fontSize: 12 }}>No activities logged yet.</p>
          ) : (
            (editing.activities || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((a, i) => (
              <div
                key={a.id || i}
                onClick={() => onEditActivity && onEditActivity(a, (editing.activities || []).findIndex((x) => x.id === a.id || x === a))}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 10,
                  marginBottom: 8,
                  padding: "10px 8px",
                  borderBottom: "1px solid #eee",
                  fontSize: 12,
                  cursor: onEditActivity ? "pointer" : "default",
                  borderRadius: 6,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, color: "#4a3527" }}>
                    {fmtDate(a.date)} · {a.type || "note"}
                  </div>
                  <div style={{ color: "#6b5240", marginTop: 2, wordBreak: "break-word" }}>{a.notes}</div>
                </div>
                {onEditActivity && (
                  <span style={{ color: "#b5552b", fontSize: 16, flexShrink: 0, marginTop: 2 }}>›</span>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {error && (
        <div style={{ background: "#fbeae5", border: "1px solid #e6c9bf", color: "#a3442e", borderRadius: 8, padding: "9px 12px", fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
        <Btn variant="ghost" onClick={onCancel}>
          Cancel
        </Btn>
        <Btn variant="primary" onClick={handleSave}>
          {editing ? "Save changes" : "Add contact"}
        </Btn>
      </div>
    </Modal>
  );
}

/* ============================================================
   CRM TAB
   ============================================================ */

function CRMTab({ db, update, showToast, nextNumber, pendingOpen, clearPendingOpen, openRecord }) {
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const [showLost, setShowLost] = useState(false);
  const [editingProspect, setEditingProspect] = useState(undefined);
  const [loggingActivityFor, setLoggingActivityFor] = useState(null);
  const [importData, setImportData] = useState(null); // Data ready to import
  const [pendingDelete, setPendingDelete] = useState(null);
  const fileInputRef = useState(null)[1]; // Dummy to create ref

  // Keep the open prospect modal in sync with the latest data. Without this,
  // editingProspect stays a stale snapshot from the moment it was opened, so
  // things like logging an activity would save correctly to Supabase/db.crm
  // but never actually show up in the still-open modal.
  useEffect(() => {
    if (!editingProspect || !db) return;
    const fresh = (db.crm || []).find((p) => p.id === editingProspect.id);
    if (fresh && fresh !== editingProspect) setEditingProspect(fresh);
  }, [db]);

  // Cross-tab navigation: open a specific prospect if asked.
  useEffect(() => {
    if (!pendingOpen || pendingOpen.type !== "prospect" || !db) return;
    const found = (db.crm || []).find((p) => p.id === pendingOpen.id);
    if (found) setEditingProspect(found);
    clearPendingOpen();
  }, [pendingOpen, db]);

  if (!db || !db.crm) {
    return (
      <section>
        <h2 className="section-title">Prospects & Sales Pipeline</h2>
        <p className="section-desc">Loading data...</p>
      </section>
    );
  }

  function handleImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const csvText = event.target?.result;
        const rows = parseCSV(csvText);
        if (rows.length === 0) {
          showToast("CSV file is empty");
          return;
        }

        // Validate and prepare data
        const validRows = rows
          .map((row) => ({
            name: row.name?.trim(),
            email: row.email?.trim() || "",
            phone: row.phone?.trim() || "",
            source: row.source?.trim() || "",
            enquiryProduct: row.enquiryProduct?.trim() || "",
            chanceOfClosing: parseInt(row.chanceOfClosing) || 50,
            currentStatus: row.currentStatus?.trim() || "call",
            firstContactDate: row.firstContactDate?.trim() || "",
            lastContactDate: row.lastContactDate?.trim() || "",
            expectedOrderEtaMonth: row.expectedOrderEtaMonth?.trim() || "",
            notes: row.notes?.trim() || "",
          }))
          .filter((row) => row.name); // Require name

        if (validRows.length === 0) {
          showToast("No valid prospects found in CSV");
          return;
        }

        setImportData({
          type: "crm",
          rows: validRows,
          fileName: file.name,
        });
      } catch (err) {
        showToast("Error parsing CSV: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  function confirmImport() {
    if (!importData) return;

    // Save to Supabase FIRST, then update local state
    (async () => {
      try {
        const savedRows = [];
        
        for (const row of importData.rows) {
          try {
            const newProspect = {
              name: row.name,
              email: row.email || "",
              phone: row.phone || "",
              source: row.source || "",
              enquiry_product: row.enquiryProduct || row.enquiry_product || "",
              chance_of_closing: row.chanceOfClosing || row.chance_of_closing || 0,
              current_status: row.currentStatus || row.current_status || "prospect",
              first_contact_date: row.firstContactDate || row.first_contact_date || null,
              last_contact_date: row.lastContactDate || row.last_contact_date || null,
              expected_order_eta_month: row.expectedOrderEtaMonth || row.expected_order_eta_month || null,
              sales_value: row.salesValue || row.sales_value || 0,
              notes: row.notes || "",
            };
            
            // id column is a real uuid type — a client-generated string like "lead_xxxxx"
            // is rejected by Postgres. Let it generate the real UUID.
            const result = await supabaseREST("POST", "crm_prospects", newProspect);
            const savedRow = Array.isArray(result) ? result[0] : result;
            savedRows.push(savedRow);
            console.log(`✅ Saved prospect: ${row.name}`);
          } catch (rowErr) {
            console.error(`❌ Failed to save prospect ${row.name}:`, rowErr);
          }
        }
        
        // Now update local state with saved rows (converted back to camelCase for UI)
        update((next) => {
          savedRows.forEach((row) => {
            const converted = fromSupabaseFormat(row, "crm_prospects");
            const exists = next.crm.find((p) => p.name.toLowerCase() === converted.name.toLowerCase());
            if (!exists) {
              next.crm.push(converted);
            }
          });
        });

        showToast(`Imported ${savedRows.length} prospect(s) to Supabase`);
        setImportData(null);
      } catch (err) {
        console.error("Import error:", err);
        showToast(`Error importing: ${err.message}`);
      }
    })();
  }

  let list = db.crm.slice().sort((a, b) => (b.lastContactDate || "").localeCompare(a.lastContactDate || ""));
  if (!showLost) {
    list = list.filter((p) => (p.currentStatus || "").trim().toLowerCase() !== "lost");
  }
  if (search) {
    const s = search.toLowerCase();
    list = list.filter((p) => {
      const haystack = [
        p.name,
        p.email,
        p.phone,
        p.source,
        p.enquiryProduct,
        p.currentStatus,
        p.notes,
        p.expectedOrderEtaMonth,
        ...(p.activities || []).map((a) => a.notes),
        ...(p.activities || []).map((a) => a.type),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(s);
    });
  }

  function logActivity(prospect, activity) {
    // Save activity to Supabase first, then update local state
    (async () => {
      try {
        const newActivity = {
          id: uid("act"),
          date: activity.date,
          type: activity.type,
          notes: activity.notes,
          createdAt: todayISO(),
        };
        
        // Update prospect with new activity
        const updatedActivities = [...(prospect.activities || []), newActivity];
        console.log("📤 Logging activity for prospect:", prospect.id, "Activity:", newActivity);
        console.log("📋 Full activities array being sent:", JSON.stringify(updatedActivities, null, 2));
        
        // Send activities and lastContactDate directly (no toSupabaseFormat)
        const payload = {
          activities: updatedActivities,
          last_contact_date: activity.date,
        };
        console.log("📦 Payload to Supabase:", JSON.stringify(payload, null, 2));
        const result = await supabaseREST("PATCH", `crm_prospects?id=eq.${prospect.id}`, payload);
        console.log("✅ Activity logged to Supabase:", result);
        
        // Then update local state
        update((next) => {
          const target = next.crm.find((p) => p.id === prospect.id);
          if (target) {
            target.activities = updatedActivities;
            target.lastContactDate = activity.date;
          }
        });
        
        // CRITICAL: Also update editingProspect so the modal refreshes with new activities
        setEditingProspect((prev) => 
          prev && prev.id === prospect.id 
            ? { ...prev, activities: updatedActivities, lastContactDate: activity.date }
            : prev
        );
        
        setLoggingActivityFor(null);
        showToast("Activity logged");
      } catch (err) {
        console.error("Log activity error:", err);
        showToast(`Error logging activity: ${err.message}`);
      }
    })();
  }

  function editActivity(prospect, index, activityData) {
    (async () => {
      try {
        const updatedActivities = (prospect.activities || []).map((a, i) =>
          i === index ? { ...a, date: activityData.date, type: activityData.type, notes: activityData.notes } : a
        );

        // Send activities directly (no toSupabaseFormat)
        await supabaseREST("PATCH", `crm_prospects?id=eq.${prospect.id}`, {
          activities: updatedActivities
        });

        update((next) => {
          const target = next.crm.find((p) => p.id === prospect.id);
          if (target) {
            target.activities = updatedActivities;
          }
        });
        
        // Update editingProspect so modal refreshes
        setEditingProspect((prev) =>
          prev && prev.id === prospect.id
            ? { ...prev, activities: updatedActivities }
            : prev
        );

        setLoggingActivityFor(null);
        showToast("Activity updated");
      } catch (err) {
        showToast(`Error updating activity: ${err.message}`);
        console.error("Edit activity error:", err);
      }
    })();
  }

  function deleteActivity(prospect, index) {
    (async () => {
      try {
        const updatedActivities = (prospect.activities || []).filter((_, i) => i !== index);

        // Send activities directly (no toSupabaseFormat)
        await supabaseREST("PATCH", `crm_prospects?id=eq.${prospect.id}`, {
          activities: updatedActivities
        });

        update((next) => {
          const target = next.crm.find((p) => p.id === prospect.id);
          if (target) {
            target.activities = updatedActivities;
            target.updatedAt = todayISO();
          }
        });
        
        // Update editingProspect so modal refreshes
        setEditingProspect((prev) =>
          prev && prev.id === prospect.id
            ? { ...prev, activities: updatedActivities }
            : prev
        );

        setLoggingActivityFor(null);
        showToast("Activity deleted");
      } catch (err) {
        showToast(`Error deleting activity: ${err.message}`);
        console.error("Delete activity error:", err);
      }
    })();
  }

  function saveProspect(payload, editing) {
    (async () => {
      try {
        if (editing) {
          const updatePayload = toSupabaseFormat(payload, "crm_prospects");
          const result = await supabaseREST("PATCH", `crm_prospects?id=eq.${editing.id}`, updatePayload);
          // Supabase returns the full updated row (Prefer: return=representation).
          // Using it here guarantees JSONB fields like `activities` and `attachments`
          // that aren't in the save payload are never lost from local state.
          const savedRow = Array.isArray(result) && result[0] ? result[0] : null;
          update((next) => {
            const target = next.crm.find((p) => p.id === editing.id);
            if (target) {
              if (savedRow) {
                Object.assign(target, fromSupabaseFormat(savedRow, "crm_prospects"));
              } else {
                // Fallback: merge payload but explicitly keep existing activities
                const existing = { activities: target.activities, attachments: target.attachments };
                Object.assign(target, payload, existing);
              }
            }
          });
        } else {
          // DON'T generate client-side id — let Supabase auto-generate UUID
          const createPayload = toSupabaseFormat(payload, "crm_prospects");
          console.log("📤 Creating prospect:", payload.name);
          const result = await supabaseREST("POST", "crm_prospects", createPayload);
          console.log("✅ Prospect created with ID:", result[0]?.id);
          
          // Supabase returns the generated record with auto-gen id
          if (result && result[0]) {
            payload.id = result[0].id;
          }
          update((next) => {
            next.crm.push({ ...payload, id: result[0]?.id });
          });
        }
        setEditingProspect(undefined);
        showToast(editing ? "Prospect updated" : "Prospect added");
      } catch (err) {
        showToast(`Error saving prospect: ${err.message}`);
        console.error("Save prospect error:", err);
      }
    })();
  }

  function deleteProspect(prospect) {
    setPendingDelete(prospect);
  }

  function convertProspectToCustomer(prospect) {
    (async () => {
      try {
        // Create the customer record in Supabase — let Postgres generate the real UUID.
        // Note: customers table has no createdAt/created_at column (confirmed by the
        // same pattern saveContact already follows) — do not send it.
        const newCustomerLocal = {
          name: prospect.name,
          email: prospect.email || "",
          phone: prospect.phone || "",
          address: { street: "", suburb: "", state: "QLD", postcode: "" },
          product: prospect.enquiryProduct || "",
          status: "Deposit",
          source: prospect.source || "",
          notes: `Converted from prospect.${prospect.notes ? " " + prospect.notes : ""}`,
          activities: prospect.activities || [],  // Copy activities from prospect
        };
        const createPayload = toSupabaseFormat(newCustomerLocal, "customers");
        delete createPayload.id;
        const result = await supabaseREST("POST", "customers", createPayload);
        const savedRow = Array.isArray(result) ? result[0] : result;
        const newCustomer = { ...newCustomerLocal, ...fromSupabaseFormat(savedRow, "customers"), id: savedRow.id };

        // Remove the prospect from Supabase now that they're a customer
        console.log("📋 Converting prospect to customer:", prospect.name);
        console.log("  Activities being copied:", prospect.activities?.length || 0, "activities");
        await supabaseREST("DELETE", `crm_prospects?id=eq.${prospect.id}`);

        // Retroactively link any existing quotes for this prospect (matched by
        // name) to the new customer record's real ID, so they show up via the
        // proper ID-based link rather than relying on name-matching going forward.
        const matchingQuotes = (db.quotes || []).filter(
          (q) => q.party && q.party.trim().toLowerCase() === prospect.name.trim().toLowerCase()
        );
        for (const q of matchingQuotes) {
          await supabaseREST("PATCH", `quotes?id=eq.${q.id}`, { customer_id: newCustomer.id });
        }

        // Then update local state to match
        update((next) => {
          next.customers.push(newCustomer);
          const idx = next.crm.findIndex((p) => p.id === prospect.id);
          if (idx >= 0) next.crm.splice(idx, 1);
          matchingQuotes.forEach((mq) => {
            const target = next.quotes.find((q) => q.id === mq.id);
            if (target) target.customerId = newCustomer.id;
          });
        });
        showToast(`${prospect.name} converted to customer`);
      } catch (err) {
        showToast(`Error converting prospect: ${err.message}`);
        console.error("Convert prospect error:", err);
      }
    })();
  }

  function createQuoteFromProspect(prospect) {
    (async () => {
      try {
        const number = nextNumber("quote", db);
        const newQuoteLocal = {
          number,
          status: "Draft",
          party: prospect.name,
          model: "",
          date: todayISO(),
          contact: prospect.email || prospect.phone || "",
          notes: `Prospect enquiry: ${prospect.enquiryProduct || "Custom"}`,
          discount: 0,
          lines: [],
          subtotal: 0,
          gst: 0,
          total: 0,
          grossProfitPct: null,
          fxRateUsed: db.fx.usdAudRate,
          createdAt: todayISO(),
        };
        const createPayload = toSupabaseFormat(newQuoteLocal, "quotes");
        delete createPayload.id;
        const result = await supabaseRESTWithSchemaFallback("POST", "quotes", createPayload);
        const savedRow = Array.isArray(result) ? result[0] : result;
        const newQuote = { ...newQuoteLocal, ...fromSupabaseFormat(savedRow, "quotes"), id: savedRow.id };

        update((next) => {
          next.quotes.push(newQuote);
        });
        showToast("Quote created from prospect. Edit to add line items.");
        if (openRecord) openRecord("quote", newQuote.id);
      } catch (err) {
        showToast(`Error creating quote: ${err.message}`);
        console.error("Create quote from prospect error:", err);
      }
    })();
  }

  return (
    <section>
      <div className="toolbar-row">
        <div>
          <h2 className="section-title">Prospects & Sales Pipeline</h2>
          <p className="section-desc">Track prospects, manage enquiries, and log activity history.</p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="secondary" onClick={() => document.getElementById("crm-import-input")?.click()}>
            ⬆ Import CSV
          </Btn>
          <Btn variant="primary" onClick={() => setEditingProspect(null)}>
            + Add prospect
          </Btn>
          <input
            id="crm-import-input"
            type="file"
            accept=".csv"
            onChange={handleImportFile}
            style={{ display: "none" }}
          />
        </div>
      </div>

      <Panel>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
          <input
            style={{ ...inputStyle, flex: 1, minWidth: 200, marginBottom: 0 }}
            type="text"
            placeholder="Search name, email, phone, notes, activity…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#6b5240", whiteSpace: "nowrap", cursor: "pointer" }}>
            <input type="checkbox" checked={showLost} onChange={(e) => setShowLost(e.target.checked)} />
            Show Lost
          </label>
        </div>

        {list.length === 0 ? (
          <Empty icon="📞" text="No prospects yet. Add one to start tracking." />
        ) : isMobile ? (
          // ── Compact clickable list for mobile ──
          <div style={{ display: "flex", flexDirection: "column" }}>
            {list.map((p) => (
              <div
                key={p.id}
                onClick={() => setEditingProspect(p)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "13px 4px", borderBottom: "1px solid #f0e8d9", cursor: "pointer",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#4a3527" }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: "#8a7a66", marginTop: 2, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span>{(p.currentStatus || "call").toUpperCase()}</span>
                    {p.enquiryProduct && <span>· {p.enquiryProduct}</span>}
                    {p.salesValue > 0 && <span>· {fmtMoney(p.salesValue, "AUD")}</span>}
                    <span
                      style={{
                        background:
                          (p.chanceOfClosing || 0) >= 70 ? "#e3ecdc" : (p.chanceOfClosing || 0) >= 30 ? "#fef2e0" : "#fbeae5",
                        color:
                          (p.chanceOfClosing || 0) >= 70 ? "#5c7a4f" : (p.chanceOfClosing || 0) >= 30 ? "#a68d4a" : "#a3442e",
                        padding: "2px 6px",
                        borderRadius: 5,
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      {p.chanceOfClosing || 0}%
                    </span>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteProspect(p); }}
                    title="Delete"
                    style={{ background: "none", border: "none", color: "#a3442e", cursor: "pointer", fontSize: 16, padding: 4 }}
                  >
                    ✕
                  </button>
                  <span style={{ color: "#b5552b", fontSize: 16 }}>›</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          // ── Rich multi-row desktop list ──
          <div style={{ display: "flex", flexDirection: "column" }}>
            {list.map((p) => {
              const chance = p.chanceOfClosing || 0;
              const chanceColor = chance >= 70 ? "#5c7a4f" : chance >= 30 ? "#a68d4a" : "#a3442e";
              const chanceBg   = chance >= 70 ? "#e3ecdc" : chance >= 30 ? "#fef2e0" : "#fbeae5";
              const statusColors = {
                lost:    { bg: "#fbeae5", color: "#a3442e" },
                deposit: { bg: "#e3ecdc", color: "#5c7a4f" },
                quote:   { bg: "#e8f0fb", color: "#3a5fa0" },
                call:    { bg: "#fef2e0", color: "#a68d4a" },
                email:   { bg: "#f3eafc", color: "#7a4fa0" },
              };
              const statusKey = (p.currentStatus || "call").toLowerCase();
              const statusStyle = statusColors[statusKey] || { bg: "#f0e8d9", color: "#6b5240" };

              const acts = (p.activities || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
              const lastAct = acts[0];
              const lastActLabel = lastAct
                ? `${lastAct.type ? lastAct.type.charAt(0).toUpperCase() + lastAct.type.slice(1) : ""} on ${lastAct.date ? new Date(lastAct.date).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : ""}${lastAct.notes ? ": " + lastAct.notes : ""}`
                : null;

              const fmtD = (d) => d ? new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—";

              return (
                <div
                  key={p.id}
                  onClick={() => setEditingProspect(p)}
                  style={{ padding: "14px 6px", borderBottom: "1px solid #f0e8d9", cursor: "pointer" }}
                  onMouseOver={(e) => e.currentTarget.style.background = "#faf7f2"}
                  onMouseOut={(e) => e.currentTarget.style.background = "transparent"}
                >
                  {/* Row 1: name, phone, email, product, value, status, chance */}
                  <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                    <div style={{ minWidth: 160, flex: "0 0 160px" }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#4a3527", lineHeight: 1.3 }}>{p.name}</div>
                    </div>
                    {p.phone && (
                      <div style={{ fontSize: 12, color: "#6b5240", display: "flex", alignItems: "center", gap: 4, flex: "0 0 auto" }}>
                        <span style={{ opacity: 0.6, fontSize: 11 }}>📞</span>
                        <span>{p.phone}</span>
                      </div>
                    )}
                    {p.email && (
                      <div style={{ fontSize: 12, color: "#6b5240", display: "flex", alignItems: "center", gap: 4, flex: "1 1 180px", minWidth: 0, overflow: "hidden" }}>
                        <span style={{ opacity: 0.6, fontSize: 11 }}>✉</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.email}</span>
                      </div>
                    )}
                    {p.enquiryProduct && (
                      <div style={{ fontSize: 12, color: "#6b5240", flex: "0 0 auto" }}>
                        <span style={{ opacity: 0.6, fontSize: 10, marginRight: 3 }}>PRODUCT</span>
                        <span style={{ fontWeight: 600 }}>{p.enquiryProduct}</span>
                      </div>
                    )}
                    {p.salesValue > 0 && (
                      <div style={{ fontSize: 12, color: "#4a3527", fontWeight: 700, flex: "0 0 auto" }}>
                        {fmtMoney(p.salesValue, "AUD")}
                      </div>
                    )}
                    <div style={{ flex: 1 }} />
                    <span style={{ background: statusStyle.bg, color: statusStyle.color, padding: "3px 8px", borderRadius: 5, fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", flex: "0 0 auto" }}>
                      {(p.currentStatus || "call").toUpperCase()}
                    </span>
                    <span style={{ background: chanceBg, color: chanceColor, padding: "3px 8px", borderRadius: 5, fontSize: 11, fontWeight: 700, flex: "0 0 auto" }}>
                      {chance}% close
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteProspect(p); }}
                        title="Delete"
                        style={{ background: "none", border: "none", color: "#a3442e", cursor: "pointer", fontSize: 15, padding: "2px 4px", opacity: 0.7 }}
                      >
                        ✕
                      </button>
                      <span style={{ color: "#b5552b", fontSize: 16 }}>›</span>
                    </div>
                  </div>
                  {/* Row 2: first contact, last contact, last activity */}
                  <div style={{ display: "flex", gap: 24, marginTop: 6, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 11, color: "#8a7a66" }}>
                      <span style={{ fontWeight: 600, color: "#6b5240" }}>First contact:</span>{" "}{fmtD(p.firstContactDate)}
                    </div>
                    <div style={{ fontSize: 11, color: "#8a7a66" }}>
                      <span style={{ fontWeight: 600, color: "#6b5240" }}>Last contact:</span>{" "}{fmtD(p.lastContactDate)}
                    </div>
                    {lastActLabel && (
                      <div style={{ fontSize: 11, color: "#8a7a66", flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: 600, color: "#6b5240" }}>Last activity:</span>{" "}
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block", maxWidth: 480, verticalAlign: "bottom" }}>
                          {lastActLabel}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {editingProspect !== undefined && (
        <CRMModal
          editing={editingProspect}
          db={db}
          onCancel={() => setEditingProspect(undefined)}
          onSave={saveProspect}
          openRecord={openRecord}
          onLogActivity={() => setLoggingActivityFor({ prospect: editingProspect, activity: null, index: null })}
          onEditActivity={(activity, index) => setLoggingActivityFor({ prospect: editingProspect, activity, index })}
          onCreateQuote={() => createQuoteFromProspect(editingProspect)}
          onConvertToCustomer={() => { convertProspectToCustomer(editingProspect); setEditingProspect(undefined); }}
          onDelete={() => { deleteProspect(editingProspect); setEditingProspect(undefined); }}
        />
      )}

      {loggingActivityFor && (
        <ActivityLogModal
          prospect={loggingActivityFor.prospect}
          activity={loggingActivityFor.activity}
          onCancel={() => setLoggingActivityFor(null)}
          onSave={(activityData) => {
            if (loggingActivityFor.activity) {
              editActivity(loggingActivityFor.prospect, loggingActivityFor.index, activityData);
            } else {
              logActivity(loggingActivityFor.prospect, activityData);
            }
          }}
          onDelete={
            loggingActivityFor.activity
              ? () => deleteActivity(loggingActivityFor.prospect, loggingActivityFor.index)
              : null
          }
        />
      )}

      {importData && (
        <Modal onClose={() => setImportData(null)}>
          <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 16px", fontSize: 19 }}>
            Import {importData.rows.length} prospect{importData.rows.length !== 1 ? "s" : ""}
          </h3>
          <p style={{ color: "#6b5240", fontSize: 13, margin: "0 0 14px" }}>
            File: <strong>{importData.fileName}</strong>
          </p>

          <div style={{ background: "#f9f7f2", border: "1px solid #d3c9b8", borderRadius: 8, padding: 12, marginBottom: 14, maxHeight: 300, overflowY: "auto" }}>
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #d3c9b8" }}>
                  <th style={{ textAlign: "left", padding: "6px 0", fontWeight: 600, color: "#4a3527" }}>Name</th>
                  <th style={{ textAlign: "left", padding: "6px 0", fontWeight: 600, color: "#4a3527" }}>Email</th>
                  <th style={{ textAlign: "left", padding: "6px 0", fontWeight: 600, color: "#4a3527" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {importData.rows.map((row, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #e3d8c6" }}>
                    <td style={{ padding: "6px 0" }}>{row.name}</td>
                    <td style={{ padding: "6px 0", color: "#8a7a66" }}>{row.email || "—"}</td>
                    <td style={{ padding: "6px 0", color: "#8a7a66" }}>{row.currentStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <Btn variant="ghost" onClick={() => setImportData(null)}>
              Cancel
            </Btn>
            <Btn variant="primary" onClick={confirmImport}>
              Import {importData.rows.length} prospect{importData.rows.length !== 1 ? "s" : ""}
            </Btn>
          </div>
        </Modal>
      )}

      {pendingDelete && (
        <ConfirmModal
          title="Delete prospect?"
          message={`Delete "${pendingDelete.name}"? This action cannot be undone.`}
          confirmLabel="Delete"
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            try {
              // Delete from Supabase first
              console.log(`🗑️ Deleting prospect ${pendingDelete.id} from Supabase`);
              await supabaseREST("DELETE", "crm_prospects", null, `id=eq.${pendingDelete.id}`);
              console.log(`✅ Successfully deleted prospect ${pendingDelete.id} from Supabase`);
              
              // Then update local state
              update((next) => {
                const idx = next.crm.findIndex((p) => p.id === pendingDelete.id);
                if (idx >= 0) next.crm.splice(idx, 1);
              });
              showToast("Prospect deleted");
            } catch (err) {
              console.error("Delete error:", err);
              showToast(`❌ Failed to delete: ${err.message}`);
            } finally {
              setPendingDelete(null);
            }
          }}
        />
      )}
    </section>
  );
}

function CRMModal({ editing, db, onCancel, onSave, openRecord, onLogActivity, onEditActivity, onCreateQuote, onConvertToCustomer, onDelete }) {
  const isMobile = useIsMobile();
  const [name, setName] = useState(editing ? editing.name : "");
  const [email, setEmail] = useState(editing ? editing.email || "" : "");
  const [phone, setPhone] = useState(editing ? editing.phone || "" : "");
  const [source, setSource] = useState(editing ? editing.source || "" : "");
  const [enquiryProduct, setEnquiryProduct] = useState(editing ? editing.enquiryProduct || "" : "");
  const [chanceOfClosing, setChanceOfClosing] = useState(editing ? String(editing.chanceOfClosing || 0) : "50");
  const [currentStatus, setCurrentStatus] = useState(editing ? editing.currentStatus || "call" : "call");
  const [firstContactDate, setFirstContactDate] = useState(editing ? editing.firstContactDate || "" : todayISO());
  const [lastContactDate, setLastContactDate] = useState(editing ? editing.lastContactDate || "" : todayISO());
  const [expectedOrderEtaMonth, setExpectedOrderEtaMonth] = useState(editing ? editing.expectedOrderEtaMonth || "" : "");
  const [salesValue, setSalesValue] = useState(editing ? String(editing.salesValue || "") : "");
  const [notes, setNotes] = useState(editing ? editing.notes || "" : "");
  const [attachments, setAttachments] = useState(editing ? editing.attachments || [] : []);
  const [error, setError] = useState("");

  const linkedQuotes =
    editing && db
      ? (db.quotes || []).filter((q) => q.party && q.party.trim().toLowerCase() === editing.name.trim().toLowerCase())
      : [];

  // Build dropdown options dynamically from all prospects in the database,
  // merged with a set of known defaults. This ensures any value already stored
  // in Supabase (even if it wasn't in the original hardcoded list) always
  // appears as a selectable option and is never silently swallowed.
  const DEFAULT_PRODUCTS = ["Campo", "Scout", "Savanna", "Custom build"];
  const DEFAULT_SOURCES  = ["Direct", "Carsales", "Facebook", "Website", "Referral", "Trade Show", "Other"];

  const allProspects = (db && db.crm) || [];

  const productOptions = Array.from(new Set([
    ...DEFAULT_PRODUCTS,
    ...allProspects.map((p) => p.enquiryProduct).filter(Boolean),
    ...(editing?.enquiryProduct ? [editing.enquiryProduct] : []),
  ])).sort();

  const sourceOptions = Array.from(new Set([
    ...DEFAULT_SOURCES,
    ...allProspects.map((p) => p.source).filter(Boolean),
    ...(editing?.source ? [editing.source] : []),
  ])).sort();

  function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Please enter a name.");
      return;
    }
    onSave(
      {
        name: trimmedName,
        email: email.trim(),
        phone: phone.trim(),
        source: source.trim(),
        enquiryProduct: enquiryProduct.trim(),
        chanceOfClosing: parseInt(chanceOfClosing) || 0,
        currentStatus,
        firstContactDate: firstContactDate || null,  // null instead of empty string
        lastContactDate: lastContactDate || null,    // null instead of empty string
        expectedOrderEtaMonth: expectedOrderEtaMonth || null,
        salesValue: parseFloat(salesValue) || 0,
        notes: notes.trim(),
        attachments,
        // activities is managed separately via logActivity — don't overwrite here
      },
      editing
    );
  }

  return (
    <Modal onClose={onCancel}>
      <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 16px", fontSize: isMobile ? 16 : 19 }}>
        {editing ? "Edit prospect" : "Add prospect"}
      </h3>

      {editing && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          {onLogActivity && (
            <Btn variant="ghost" size="sm" onClick={onLogActivity}>Log activity</Btn>
          )}
          {onCreateQuote && (
            <Btn variant="ghost" size="sm" onClick={onCreateQuote}>Create quote</Btn>
          )}
          {onConvertToCustomer && (
            <Btn variant="ghost" size="sm" onClick={onConvertToCustomer} style={{ color: "#5c7a4f" }}>✓ Convert to Customer</Btn>
          )}
          {onDelete && (
            <Btn variant="ghost" size="sm" onClick={onDelete} style={{ color: "#a3442e" }}>Delete</Btn>
          )}
        </div>
      )}

      <Field label="Name (required)">
        <input style={inputStyle} type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      {editing && linkedQuotes.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: "#6b5240", margin: "0 0 6px" }}>Linked quotes</p>
          {linkedQuotes.map((q) => (
            <div
              key={q.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 12,
                padding: "6px 10px",
                background: "#f9f7f2",
                border: "1px solid #e3d8c6",
                borderRadius: 6,
                marginBottom: 6,
              }}
            >
              <span>
                Quote #{q.number} · {fmtDate(q.createdAt || q.date)} · {q.model || "—"} · {fmtMoney(q.total || 0, "AUD")}
              </span>
              {openRecord && (
                <Btn variant="text" size="sm" onClick={() => openRecord("quote", q.id)}>
                  View →
                </Btn>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="grid2">
        <Field label="Email">
          <input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Phone">
          <input style={inputStyle} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>

      <div className="grid2">
        <Field label="Source">
          <select style={inputStyle} value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">—</option>
            {sourceOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Enquired about">
          <select style={inputStyle} value={enquiryProduct} onChange={(e) => setEnquiryProduct(e.target.value)}>
            <option value="">—</option>
            {productOptions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid2">
        <Field label="Chance of closing (%)">
          <input style={inputStyle} type="number" min="0" max="100" value={chanceOfClosing} onChange={(e) => setChanceOfClosing(e.target.value)} />
        </Field>
        <Field label="Current status">
          <select style={inputStyle} value={currentStatus} onChange={(e) => setCurrentStatus(e.target.value)}>
            <option value="call">Call</option>
            <option value="quote">Quote</option>
            <option value="deposit">Deposit received</option>
            <option value="delivered">Delivered</option>
            <option value="lost">Lost</option>
          </select>
        </Field>
      </div>

      <div className="grid2">
        <Field label="First contact">
          <input style={inputStyle} type="date" value={firstContactDate} onChange={(e) => setFirstContactDate(e.target.value)} />
        </Field>
        <Field label="Last contact">
          <input style={inputStyle} type="date" value={lastContactDate} onChange={(e) => setLastContactDate(e.target.value)} />
        </Field>
      </div>

      <Field label="Expected order ETA (month)">
        <input
          style={inputStyle}
          type="month"
          value={expectedOrderEtaMonth}
          onChange={(e) => setExpectedOrderEtaMonth(e.target.value)}
        />
      </Field>

      <Field label="Sales Value (AUD)">
        <input
          style={inputStyle}
          type="number"
          min="0"
          step="0.01"
          placeholder="e.g. 45000 (auto-filled from quote or manual)"
          value={salesValue}
          onChange={(e) => setSalesValue(e.target.value)}
        />
      </Field>

      <Field label="Notes">
        <textarea
          style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>

      {editing && (
        <div style={{ borderTop: "1px solid #e3d8c6", paddingTop: 14, marginTop: 14 }}>
          <h4 style={{ fontSize: 13, fontWeight: 600, color: "#6b5240", margin: "0 0 10px" }}>Attachments</h4>
          <AttachmentsPanel
            recordId={editing.id}
            recordType="crm_prospects"
            attachments={attachments}
            onAttachmentsChange={setAttachments}
          />
        </div>
      )}

      {editing && (
        <div style={{ borderTop: "1px solid #e3d8c6", paddingTop: 14, marginTop: 14 }}>
          <h4 style={{ fontSize: 13, fontWeight: 600, color: "#6b5240", margin: "0 0 10px" }}>
            Activity timeline ({(editing.activities || []).length})
          </h4>
          {(editing.activities || []).length === 0 ? (
            <p className="muted" style={{ fontSize: 12 }}>No activities logged yet.</p>
          ) : (
            editing.activities.map((a, i) => (
              <div
                key={a.id || i}
                onClick={() => onEditActivity && onEditActivity(a, i)}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 10,
                  marginBottom: 8,
                  padding: "10px 8px",
                  borderBottom: "1px solid #eee",
                  fontSize: 12,
                  cursor: onEditActivity ? "pointer" : "default",
                  borderRadius: 6,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, color: "#4a3527" }}>
                    {fmtDate(a.date)} · {a.type || "note"}
                  </div>
                  <div style={{ color: "#6b5240", marginTop: 2, wordBreak: "break-word" }}>{a.notes}</div>
                </div>
                {onEditActivity && (
                  <span style={{ color: "#b5552b", fontSize: 16, flexShrink: 0, marginTop: 2 }}>›</span>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {error && (
        <div style={{ background: "#fbeae5", border: "1px solid #e6c9bf", color: "#a3442e", borderRadius: 8, padding: "9px 12px", fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
        <Btn variant="ghost" onClick={onCancel}>
          Cancel
        </Btn>
        <Btn variant="primary" onClick={handleSave}>
          {editing ? "Save changes" : "Add prospect"}
        </Btn>
      </div>
    </Modal>
  );
}

function ActivityLogModal({ prospect, activity, onCancel, onSave, onDelete }) {
  const isMobile = useIsMobile();
  const isEditing = !!activity;
  const [date, setDate] = useState(activity ? activity.date : todayISO());
  const [type, setType] = useState(activity ? activity.type || "call" : "call");
  const [notes, setNotes] = useState(activity ? activity.notes || "" : "");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  function handleSave() {
    const trimmedNotes = notes.trim();
    if (!trimmedNotes) {
      setError("Please enter some notes about the activity.");
      return;
    }
    onSave({ date, type, notes: trimmedNotes });
  }

  return (
    <Modal onClose={onCancel}>
      <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 16px", fontSize: isMobile ? 16 : 19 }}>
        {isEditing ? `Edit activity — ${prospect.name}` : `Log activity for ${prospect.name}`}
      </h3>

      <div className="grid2">
        <Field label="Date">
          <input style={inputStyle} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Type">
          <select style={inputStyle} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="call">Phone call</option>
            <option value="email">Email</option>
            <option value="meeting">In-person meeting</option>
            <option value="note">Note</option>
          </select>
        </Field>
      </div>

      <Field label="Notes">
        <textarea
          style={{ ...inputStyle, minHeight: 100, resize: "vertical" }}
          placeholder="What did you discuss? Next steps? Any decisions?"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>

      {error && (
        <div style={{ background: "#fbeae5", border: "1px solid #e6c9bf", color: "#a3442e", borderRadius: 8, padding: "9px 12px", fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {confirmDelete ? (
        <div style={{ background: "#fbeae5", border: "1px solid #e6c9bf", borderRadius: 8, padding: 14, marginTop: 4 }}>
          <p style={{ fontSize: 13, color: "#a3442e", margin: "0 0 12px", fontWeight: 600 }}>
            Delete this activity? This cannot be undone.
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
            <Btn variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Btn>
            <Btn variant="danger" onClick={onDelete}>
              Yes, delete
            </Btn>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
          <div>
            {isEditing && onDelete && (
              <Btn variant="ghost" onClick={() => setConfirmDelete(true)} style={{ color: "#a3442e" }}>
                Delete
              </Btn>
            )}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Btn variant="ghost" onClick={onCancel}>
              Cancel
            </Btn>
            <Btn variant="primary" onClick={handleSave}>
              {isEditing ? "Save changes" : "Log activity"}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ============================================================
   DASHBOARD TAB
   ============================================================ */

// Helper: Get date range for Australian FY quarter
// yearOffset: 0 = current FY, -1 = previous FY, etc.
function getQuarterDateRange(quarter, yearOffset) {
  const currentYear = new Date().getFullYear();
  const fyStart = currentYear + yearOffset;
  const ranges = {
    Q1: { start: `${fyStart}-07-01`,     end: `${fyStart}-09-30` },
    Q2: { start: `${fyStart}-10-01`,     end: `${fyStart}-12-31` },
    Q3: { start: `${fyStart + 1}-01-01`, end: `${fyStart + 1}-03-31` },
    Q4: { start: `${fyStart + 1}-04-01`, end: `${fyStart + 1}-06-30` },
  };
  return ranges[quarter];
}

// Helper: Check if invoice month (YYYY-MM) is within date range
function isInDateRange(invoiceMonth, startDate, endDate) {
  if (!invoiceMonth) return false;
  const m = invoiceMonth.slice(0, 7); // normalise to YYYY-MM
  return m >= startDate.slice(0, 7) && m <= endDate.slice(0, 7);
}

// Helper: Calculate total sales + monthly breakdown for a period.
// If `status` is omitted/falsy, includes every customer regardless of status
// EXCEPT "Canceled" — i.e. all real income (Deposit + Paid + Delivered combined).
// If `status` is provided, filters to that exact status only (legacy behaviour).
function calculatePeriodSales(customers, startDate, endDate, status) {
  const filtered = customers.filter((c) => {
    if (!Array.isArray(c.invoices)) return false;
    const s = (c.status || "").trim();
    if (status) return s === status.trim();
    return s.toLowerCase() !== "canceled";
  });
  const monthTotals = {};
  filtered.forEach((c) => {
    (c.invoices || []).forEach((inv) => {
      if (!inv || !inv.invoiceMonth) return;
      if (isInDateRange(inv.invoiceMonth, startDate, endDate)) {
        const key = inv.invoiceMonth.slice(0, 7);
        if (!monthTotals[key]) monthTotals[key] = 0;
        monthTotals[key] += parseFloat(inv.amount) || 0;
      }
    });
  });
  const periodTotal = Object.values(monthTotals).reduce((s, v) => s + v, 0);
  return { monthTotals, periodTotal };
}

// Companion to calculatePeriodSales: returns individual transaction-level detail
// for a single YYYY-MM month, for the "click a monthly total to drill down" view.
// Each row uses the customer's invoiceNumber (customers have one invoice number
// covering potentially multiple payments — there is no separate per-payment
// invoice number in the current data model, confirmed by the Payment Schedule
// editor's fields, which are just amount + month, not a place to enter a
// distinct invoice number per payment).
function getTransactionsForMonth(customers, monthKey) {
  const rows = [];
  (customers || []).forEach((c) => {
    const s = (c.status || "").trim().toLowerCase();
    if (s === "canceled") return;
    (c.invoices || []).forEach((inv) => {
      if (!inv || !inv.invoiceMonth) return;
      if (inv.invoiceMonth.slice(0, 7) !== monthKey) return;
      rows.push({
        customerName: c.name,
        customerId: c.id,
        invoiceNumber: c.invoiceNumber || "—",
        amount: parseFloat(inv.amount) || 0,
        product: c.product || "—",
        invoiceMonth: inv.invoiceMonth,
      });
    });
  });
  return rows.sort((a, b) => (a.customerName || "").localeCompare(b.customerName || ""));
}

// Helper: Count distinct products sold in period
function countProductsSold(customers, startDate, endDate, status) {
  const filtered = customers.filter((c) => (c.status || "").trim() === status.trim() && c.product && Array.isArray(c.invoices));
  const productCounts = {};
  filtered.forEach((c) => {
    const hasInvoiceInPeriod = c.invoices.some((inv) => inv && inv.invoiceMonth && isInDateRange(inv.invoiceMonth, startDate, endDate));
    if (hasInvoiceInPeriod) {
      productCounts[c.product] = (productCounts[c.product] || 0) + 1;
    }
  });
  return productCounts;
}

function DashboardTab({ db, setTab, openRecord }) {
  const isMobile = useIsMobile();
  // Each column is a fiscal year ending June 30 of fyYear
  // FY2026 = Jul 2025 – Jun 2026
  const currentMonth = new Date().getMonth() + 1; // 1-12
  const currentCalYear = new Date().getFullYear();
  // Current FY end year: if we're past June, current FY ends next year; otherwise this year
  const currentFYEnd = currentMonth >= 7 ? currentCalYear + 1 : currentCalYear;
  // Show every fiscal year from FY23/24 through to the current FY by default.
  // fyEndYear 2024 = FY23/24 (Jul 2023 - Jun 2024).
  const EARLIEST_FY_END = 2024;
  const defaultColumns = [];
  for (let y = EARLIEST_FY_END; y <= currentFYEnd; y++) defaultColumns.push(y);
  const [columns, setColumns] = React.useState(defaultColumns);
  const [drillDown, setDrillDown] = React.useState(null); // { key: "2026-06", label: "June FY25/26" }

  const getFYRange = (fyEndYear) => ({
    start: `${fyEndYear - 1}-07-01`,
    end:   `${fyEndYear}-06-30`,
    label: `FY${String(fyEndYear - 1).slice(-2)}/${String(fyEndYear).slice(-2)}`,
  });

  const addColumn = (fyEndYear) => {
    if (!columns.includes(fyEndYear) && columns.length < 12) {
      setColumns([...columns, fyEndYear].sort());
    }
  };
  const removeColumn = (fyEndYear) => {
    if (columns.length > 1) setColumns(columns.filter(y => y !== fyEndYear));
  };

  if (!db || !db.crm || !db.quotes || !db.pos) {
    return (
      <section>
        <h2 className="section-title">Sales Dashboard</h2>
        <p className="section-desc">Loading data...</p>
      </section>
    );
  }

  const periods = columns.map(getFYRange);

  // Sales funnel counts — normalise status to lowercase+trimmed for comparison
  const normStatus = (s) => (s || "").trim().toLowerCase();
  const funnelStats = {
    call:      db.crm.filter((p) => ["call","phone","email","visit"].includes(normStatus(p.currentStatus))).length,
    quote:     db.crm.filter((p) => normStatus(p.currentStatus) === "quote").length,
    deposit:   db.crm.filter((p) => normStatus(p.currentStatus) === "deposit").length,
    delivered: db.crm.filter((p) => normStatus(p.currentStatus) === "delivered").length,
  };

  // Pipeline value — sum of salesValue for all non-delivered prospects
  const pipelineValue = db.crm
    .filter((p) => normStatus(p.currentStatus) !== "delivered")
    .reduce((sum, p) => sum + (parseFloat(p.salesValue) || 0), 0);

  // PO tracking
  const openPos = db.pos.filter((po) => po.status !== "Received").length;
  const totalPoAmount = db.pos.reduce((sum, po) => sum + (po.total || 0), 0);

  // Expected delivery POs
  const expectedDeliveryPos = db.pos.filter((po) => po.status === "Sent" || po.status === "Received");
  const expectedDeliverAmount = expectedDeliveryPos.reduce((sum, po) => sum + (po.total || 0), 0);

  // Expected profit: accepted quotes revenue vs their line item costs
  const acceptedQuotes = db.quotes.filter((q) => q.status === "Accepted");
  const acceptedQuotesTotal = acceptedQuotes.reduce((sum, q) => sum + (q.total || 0), 0);
  
  // Calculate cost from accepted quote line items
  const expectedCost = acceptedQuotes.reduce((sum, quote) => {
    const quoteCost = (quote.lines || []).reduce((qSum, line) => {
      const lineCost = line.cost || 0;
      const lineQty = line.qty || 0;
      return qSum + (lineCost * lineQty);
    }, 0);
    return sum + quoteCost;
  }, 0);
  
  const expectedMargin = acceptedQuotesTotal - expectedCost;
  const expectedMarginPct = acceptedQuotesTotal > 0 ? ((expectedMargin / acceptedQuotesTotal) * 100).toFixed(1) : 0;

  // Stat box style - clickable
  const statBoxStyle = {
    background: "#f6f1e7",
    borderRadius: 8,
    padding: 16,
    cursor: "pointer",
    transition: "all 0.2s ease",
    border: "1px solid #e3d8c6",
  };

  const statBoxHoverStyle = {
    ...statBoxStyle,
    background: "#f0e8d9",
    borderColor: "#b5552b",
  };

  return (
    <>
      {/* ── SALES PERFORMANCE DASHBOARD ── */}
      <section style={{ marginBottom: 32, padding: 20, background: "#f9f5f0", borderRadius: 8, border: "1px solid #e3d8c6" }}>
        <h2 className="section-title" style={{ marginTop: 0 }}>Sales Performance</h2>

        {/* FY Column selector */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#6b5240" }}>Columns:</span>
          {columns.map(fyEnd => (
            <span key={fyEnd} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", background: "#b5552b", color: "#fff", borderRadius: 4, fontSize: 12, fontWeight: 600 }}>
              {getFYRange(fyEnd).label}
              {columns.length > 1 && (
                <button onClick={() => removeColumn(fyEnd)} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0, marginLeft: 2 }}>×</button>
              )}
            </span>
          ))}
          {columns.length < 4 && (
            <select
              onChange={(e) => { if (e.target.value) { addColumn(parseInt(e.target.value)); e.target.value = ""; }}}
              style={{ padding: "4px 8px", fontSize: 12, border: "1px solid #d4a574", borderRadius: 4, color: "#6b5240", background: "#fff" }}
              defaultValue=""
            >
              <option value="">+ Add FY…</option>
              {[currentFYEnd + 1, currentFYEnd, currentFYEnd - 1, currentFYEnd - 2, currentFYEnd - 3, currentFYEnd - 4].filter(y => !columns.includes(y)).map(y => (
                <option key={y} value={y}>{getFYRange(y).label}</option>
              ))}
            </select>
          )}
        </div>

        {periods.length === 0 ? (
          <p style={{ fontSize: 13, color: "#8a7a66" }}>Add at least one FY column above.</p>
        ) : (() => {
          const monthNames = ["Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar","Apr","May","Jun"];
          const monthNumbers = [7,8,9,10,11,12,1,2,3,4,5,6]; // calendar month number for each row, in FY order

          const periodData = periods.map(period => ({
            ...period,
            income: calculatePeriodSales(db.customers || [], period.start, period.end),
          }));

          const thStyle = { padding: "8px 10px", fontWeight: 700, fontSize: 12, textAlign: "right", whiteSpace: "nowrap" };
          const tdStyle = { padding: "6px 10px", fontSize: 12, textAlign: "right" };
          const tdLeft  = { padding: "6px 10px", fontSize: 12, textAlign: "left", color: "#6b5240" };

          // ---- Build "Deposits Received + Forecast" table data ----
          // Rows = every customer (any non-Canceled status) who has a payment
          // dated this month or later — status doesn't gate this table; it's
          // purely about cash already in this month plus what's still expected.
          // Columns = current month, then forward.
          const cutoff = (() => {
            const d = new Date();
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          })();
          const forecastCustomers = (db.customers || []).filter(
            (c) => (c.status || "").toLowerCase().trim() !== "canceled"
          );
          const depositRowsRaw = forecastCustomers
            .map((c) => {
              const byKey = {};
              // Primary: read from invoices JSONB array
              (c.invoices || []).forEach((inv) => {
                if (!inv || !inv.invoiceMonth) return;
                const key = inv.invoiceMonth.slice(0, 7);
                byKey[key] = (byKey[key] || 0) + (parseFloat(inv.amount) || 0);
              });
              // Fallback: read from flat columns if JSONB array is empty
              if (Object.keys(byKey).length === 0) {
                [
                  { month: c.invoice_month_1st || c.invoiceMonth1st, amount: c.invoice_amount_1st || c.invoiceAmount1st },
                  { month: c.invoice_month_2nd || c.invoiceMonth2nd, amount: c.invoice_amount_2nd || c.invoiceAmount2nd },
                  { month: c.invoice_month_3rd || c.invoiceMonth3rd, amount: c.invoice_amount_3rd || c.invoiceAmount3rd },
                ].forEach(({ month, amount }) => {
                  if (month && amount) {
                    const key = String(month).slice(0, 7);
                    byKey[key] = (byKey[key] || 0) + (parseFloat(amount) || 0);
                  }
                });
              }
              return { customer: c.name, product: c.product || "—", customerId: c.id, byKey };
            })
            // Only keep customers who actually have a payment this month or later —
            // this is what excludes customers whose payments are all in the past.
            .filter((r) => Object.keys(r.byKey).some((k) => k >= cutoff));

          const allDepositMonthKeys = [...new Set(depositRowsRaw.flatMap(r => Object.keys(r.byKey)))]
            .filter(k => k >= cutoff)
            .sort();
          const depositColumnsTrimmed = allDepositMonthKeys.map(key => {
            const [y, m] = key.split('-');
            return { key, label: `${m}/${String(y).slice(-2)}` };
          });

          const depositMonthTotals = {};
          depositColumnsTrimmed.forEach(col => {
            depositMonthTotals[col.key] = depositRowsRaw.reduce((sum, r) => sum + (r.byKey[col.key] || 0), 0);
          });
          const depositGrandTotal = Object.values(depositMonthTotals).reduce((s, v) => s + v, 0);

          return (
            <>
              {/* ── Income / Sales table: rows = months, columns = FY years. Includes all non-Canceled statuses (Deposit + Paid + Delivered) ── */}
              <h3 style={{ fontSize: 14, fontWeight: 700, color: "#6b5240", margin: "0 0 4px" }}>Income / Sales</h3>
              <p style={{ fontSize: 11, color: "#8a7a66", margin: "0 0 10px" }}>Click any monthly total to see the individual transactions behind it.</p>
              <div style={{ overflowX: "auto", marginBottom: 32 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff", borderRadius: 6, overflow: "hidden", border: "1px solid #e3d8c6" }}>
                  <thead>
                    <tr style={{ background: "#f0e8d9", borderBottom: "2px solid #b5552b" }}>
                      <th style={{ ...thStyle, textAlign: "left", width: 70 }}>Month</th>
                      {periodData.map((pd, i) => (
                        <th key={i} style={{ ...thStyle, color: "#b5552b", borderLeft: "2px solid #e3d8c6" }}>{pd.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {monthNames.map((mn, mi) => {
                      const monthNum = monthNumbers[mi];
                      return (
                        <tr key={mn} style={{ background: mi % 2 === 0 ? "#fff" : "#faf7f3", borderBottom: "1px solid #f0e8d9" }}>
                          <td style={tdLeft}>{mn}</td>
                          {periodData.map((pd, i) => {
                            // figure out the actual YYYY-MM key for this FY column + month row
                            const fyEndYear = columns[i];
                            const calYear = monthNum >= 7 ? fyEndYear - 1 : fyEndYear;
                            const key = `${calYear}-${String(monthNum).padStart(2, '0')}`;
                            const val = pd.income.monthTotals[key];
                            return (
                              <td
                                key={i}
                                onClick={() => val && setDrillDown({ key, label: `${mn} ${pd.label}` })}
                                style={{
                                  ...tdStyle,
                                  borderLeft: "2px solid #e3d8c6",
                                  color: "#b5552b",
                                  cursor: val ? "pointer" : "default",
                                  textDecoration: val ? "underline" : "none",
                                  textDecorationColor: "#e3c9b5",
                                }}
                              >
                                {val ? `$${val.toLocaleString()}` : "—"}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                    <tr style={{ background: "#f0e8d9", borderTop: "2px solid #b5552b", fontWeight: 700 }}>
                      <td style={{ ...tdLeft, fontWeight: 700 }}>Total</td>
                      {periodData.map((pd, i) => (
                        <td key={i} style={{ ...tdStyle, borderLeft: "2px solid #e3d8c6", color: "#b5552b", fontWeight: 700 }}>
                          ${pd.income.periodTotal.toLocaleString()}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* ── Deposits Received + Forecast table: rows = customer + product, columns = current month → forward ── */}
              <h3 style={{ fontSize: 14, fontWeight: 700, color: "#4a5f7f", margin: "0 0 4px" }}>Deposits Received & Forecast</h3>
              <p style={{ fontSize: 11, color: "#8a7a66", margin: "0 0 10px" }}>First column is this month's payments received; remaining columns are scheduled/forecast. Click any monthly total to see individual transactions.</p>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff", borderRadius: 6, overflow: "hidden", border: "1px solid #c8d8e8", fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: "#e8eef5", borderBottom: "2px solid #6b8fc4" }}>
                      <th style={{ ...thStyle, textAlign: "left", color: "#4a5f7f" }}>Customer</th>
                      <th style={{ ...thStyle, textAlign: "left", color: "#4a5f7f" }}>Product</th>
                      {depositColumnsTrimmed.map(col => (
                        <th key={col.key} style={{ ...thStyle, color: "#4a5f7f", borderLeft: "1px solid #c8d8e8" }}>{col.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {depositRowsRaw.length === 0 && (
                      <tr><td colSpan={2 + depositColumnsTrimmed.length} style={{ padding: 12, textAlign: "center", color: "#aaa" }}>No upcoming deposits.</td></tr>
                    )}
                    {depositRowsRaw.map((r, ri) => (
                      <tr key={ri} style={{ background: ri % 2 === 0 ? "#fff" : "#f7fafc", borderBottom: "1px solid #e8eef5" }}>
                        <td style={{ ...tdLeft, color: "#4a5f7f" }}>{r.customer}</td>
                        <td style={{ ...tdLeft, color: "#4a5f7f" }}>{r.product}</td>
                        {depositColumnsTrimmed.map(col => (
                          <td
                            key={col.key}
                            onClick={() => r.byKey[col.key] && openRecord && openRecord("customer", r.customerId)}
                            style={{
                              ...tdStyle, color: "#6b8fc4", borderLeft: "1px solid #e8eef5",
                              cursor: r.byKey[col.key] ? "pointer" : "default",
                              textDecoration: r.byKey[col.key] ? "underline" : "none",
                              textDecorationColor: "#a8c4e8",
                            }}
                          >
                            {r.byKey[col.key] ? `$${r.byKey[col.key].toLocaleString()}` : "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {depositRowsRaw.length > 0 && (
                      <tr style={{ background: "#e8eef5", borderTop: "2px solid #6b8fc4", fontWeight: 700 }}>
                        <td style={{ ...tdLeft, fontWeight: 700, color: "#4a5f7f" }} colSpan={2}>Total (${depositGrandTotal.toLocaleString()})</td>
                        {depositColumnsTrimmed.map(col => (
                          <td
                            key={col.key}
                            onClick={() => depositMonthTotals[col.key] && setDrillDown({ key: col.key, label: col.label })}
                            style={{
                              ...tdStyle, color: "#4a5f7f", borderLeft: "1px solid #c8d8e8", fontWeight: 700,
                              cursor: depositMonthTotals[col.key] ? "pointer" : "default",
                              textDecoration: depositMonthTotals[col.key] ? "underline" : "none",
                              textDecorationColor: "#a8c4e8",
                            }}
                          >
                            {depositMonthTotals[col.key] ? `$${depositMonthTotals[col.key].toLocaleString()}` : "—"}
                          </td>
                        ))}
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          );
        })()}
      </section>

      {/* ── EXISTING PIPELINE / PO / MARGIN DASHBOARD ── */}
      <section>
      <h2 className="section-title">Sales Dashboard</h2>
      <p className="section-desc">Overview of your sales pipeline, purchase orders, and expected profitability. Click any stat to view details.</p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 28 }}>
        <div
          style={statBoxStyle}
          onMouseEnter={(e) => Object.assign(e.currentTarget.style, { background: "#f0e8d9", borderColor: "#b5552b" })}
          onMouseLeave={(e) => Object.assign(e.currentTarget.style, { background: "#f6f1e7", borderColor: "#e3d8c6" })}
          onClick={() => setTab("crm")}
        >
          <p style={{ fontSize: 12, color: "#8a7a66", margin: "0 0 8px", fontWeight: 600 }}>Pipeline value</p>
          <p style={{ fontSize: 24, fontWeight: 700, color: "#4a3527", margin: 0 }}>{fmtMoney(pipelineValue, "AUD")}</p>
        </div>
        <div
          style={statBoxStyle}
          onMouseEnter={(e) => Object.assign(e.currentTarget.style, { background: "#f0e8d9", borderColor: "#b5552b" })}
          onMouseLeave={(e) => Object.assign(e.currentTarget.style, { background: "#f6f1e7", borderColor: "#e3d8c6" })}
          onClick={() => setTab("po")}
        >
          <p style={{ fontSize: 12, color: "#8a7a66", margin: "0 0 8px", fontWeight: 600 }}>Open POs</p>
          <p style={{ fontSize: 24, fontWeight: 700, color: "#4a3527", margin: 0 }}>{openPos}</p>
        </div>
        <div
          style={statBoxStyle}
          onMouseEnter={(e) => Object.assign(e.currentTarget.style, { background: "#f0e8d9", borderColor: "#b5552b" })}
          onMouseLeave={(e) => Object.assign(e.currentTarget.style, { background: "#f6f1e7", borderColor: "#e3d8c6" })}
          onClick={() => setTab("quotes")}
        >
          <p style={{ fontSize: 12, color: "#8a7a66", margin: "0 0 8px", fontWeight: 600 }}>Expected margin</p>
          <p style={{ fontSize: 24, fontWeight: 700, color: expectedMargin >= 0 ? "#5c7a4f" : "#a3442e", margin: 0 }}>
            {expectedMarginPct}%
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
        <Panel>
          <h3 style={{ fontFamily: "Georgia,serif", fontSize: 16, color: "#4a3527", margin: "0 0 12px" }}>Sales funnel</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>Call</span>
              <strong>{funnelStats.call}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>Quote</span>
              <strong>{funnelStats.quote}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>Deposit received</span>
              <strong>{funnelStats.deposit}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>Delivered</span>
              <strong>{funnelStats.delivered}</strong>
            </div>
          </div>
        </Panel>

        <Panel>
          <h3 style={{ fontFamily: "Georgia,serif", fontSize: 16, color: "#4a3527", margin: "0 0 12px" }}>PO status</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>Total POs</span>
              <strong>{db.pos.length}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>Total amount</span>
              <strong>{fmtMoney(totalPoAmount, "AUD")}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>Expected delivery</span>
              <strong>{fmtMoney(expectedDeliverAmount, "AUD")}</strong>
            </div>
          </div>
        </Panel>

        <Panel>
          <h3 style={{ fontFamily: "Georgia,serif", fontSize: 16, color: "#4a3527", margin: "0 0 12px" }}>Revenue vs cost</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>Expected revenue</span>
              <strong>{fmtMoney(acceptedQuotesTotal, "AUD")}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>Expected cost</span>
              <strong>{fmtMoney(expectedCost, "AUD")}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, paddingTop: 8, borderTop: "1px solid #e3d8c6" }}>
              <span>Expected profit</span>
              <strong style={{ color: expectedMargin >= 0 ? "#5c7a4f" : "#a3442e" }}>{fmtMoney(expectedMargin, "AUD")}</strong>
            </div>
          </div>
        </Panel>
      </div>

      {/* Shipments list */}
      <Panel style={{ marginTop: 24 }}>
        <h3 style={{ fontFamily: "Georgia,serif", fontSize: 16, color: "#4a3527", margin: "0 0 16px" }}>Shipments due</h3>
        {(() => {
          // Filter: Only POs with customsClearance > 0, exclude consolidated members
          const shipmentsWithCustoms = db.pos.filter((po) => !po.consolidatedGroupId && (po.customsClearance || 0) > 0);
          
          if (shipmentsWithCustoms.length === 0) {
            return <p style={{ fontSize: 13, color: "#8a7a66", margin: 0 }}>No pending shipments with customs charges.</p>;
          }
          
          // Generate 6 months starting from current date
          const today = new Date();
          const months = [];
          for (let i = 0; i < 6; i++) {
            const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
            months.push({ date: d, label: d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }) });
          }
          
          // Build payment data for each PO
          const shipmentsData = shipmentsWithCustoms.map(po => {
            const monthPayments = months.map(m => {
              const monthPayment = (po.paymentMilestones || [])
                .filter(pm => {
                  if (!pm.due) return false;
                  const pmDate = new Date(pm.due);
                  return pmDate.getFullYear() === m.date.getFullYear() && pmDate.getMonth() === m.date.getMonth();
                })
                .reduce((sum, pm) => sum + (parseFloat(pm.amount) || 0), 0);
              return monthPayment > 0 ? monthPayment : null;
            });
            
            return { po, monthPayments, customs: po.customsClearance || 0 };
          });
          
          const isMobile = window.innerWidth < 768;
          
          if (isMobile) {
            // MOBILE: Card layout with scroll
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {shipmentsData.slice(0, 5).map((item, idx) => (
                  <div 
                    key={idx}
                    onClick={() => openRecord && openRecord("po", item.po.id)}
                    style={{
                      padding: 12,
                      border: "1px solid #d4a574",
                      borderRadius: 4,
                      backgroundColor: "#faf7f2",
                      cursor: openRecord ? "pointer" : "default"
                    }}
                  >
                    <div style={{ fontWeight: 700, color: "#4a3527", marginBottom: 8 }}>
                      {item.po.party} · {item.po.model || "—"}
                    </div>
                    <div style={{ fontSize: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                      {months.map((m, mi) => (
                        <div key={mi}>
                          <div style={{ fontSize: 11, color: "#8a7a66", fontWeight: 600 }}>{m.label}</div>
                          <div style={{ color: item.monthPayments[mi] ? "#4a3527" : "#ccc" }}>
                            {item.monthPayments[mi] ? `$${item.monthPayments[mi].toLocaleString()}` : "—"}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div style={{ borderTop: "1px solid #d4a574", paddingTop: 8 }}>
                      <div style={{ fontSize: 11, color: "#8a7a66", fontWeight: 600 }}>FF (Customs)</div>
                      <div style={{ fontWeight: 700, color: "#b5552b" }}>
                        ${item.customs.toLocaleString('en-AU')}
                      </div>
                    </div>
                  </div>
                ))}
                {shipmentsData.length > 5 && (
                  <div style={{ fontSize: 12, color: "#8a7a66", textAlign: "center" }}>
                    + {shipmentsData.length - 5} more. <button onClick={() => setTab("shipments")} style={{ background: "none", border: "none", color: "#b5552b", cursor: "pointer", textDecoration: "underline" }}>View all</button>
                  </div>
                )}
              </div>
            );
          } else {
            // DESKTOP: Table layout with monthly columns
            return (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: "#f9f7f2", borderBottom: "2px solid #b5552b" }}>
                      <th style={{ textAlign: "left", padding: "8px 6px", fontWeight: 700, minWidth: 100 }}>Supplier</th>
                      <th style={{ textAlign: "left", padding: "8px 6px", fontWeight: 700, minWidth: 120 }}>Reference</th>
                      {months.map((m, idx) => (
                        <th key={idx} style={{ textAlign: "right", padding: "8px 6px", fontWeight: 700, minWidth: 90 }}>
                          {m.label}
                        </th>
                      ))}
                      <th style={{ textAlign: "right", padding: "8px 6px", fontWeight: 700, minWidth: 80 }}>FF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shipmentsData.map((item, idx) => (
                      <tr
                        key={idx}
                        onClick={() => openRecord && openRecord("po", item.po.id)}
                        style={{
                          borderBottom: "1px solid #e3d8c6",
                          cursor: openRecord ? "pointer" : "default",
                          backgroundColor: idx % 2 === 0 ? "#faf7f2" : "white"
                        }}
                      >
                        <td style={{ padding: "8px 6px", color: "#4a3527", fontWeight: 600 }}>
                          {item.po.party}
                        </td>
                        <td style={{ padding: "8px 6px", color: "#6b5240" }}>
                          {item.po.model || "—"}
                        </td>
                        {item.monthPayments.map((amount, mi) => (
                          <td key={mi} style={{ padding: "8px 6px", textAlign: "right", color: amount ? "#4a3527" : "#ccc", fontWeight: amount ? 600 : 400 }}>
                            {amount ? `$${amount.toLocaleString()}` : "—"}
                          </td>
                        ))}
                        <td style={{ padding: "8px 6px", textAlign: "right", fontWeight: 700, color: "#b5552b" }}>
                          ${item.customs.toLocaleString('en-AU')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {shipmentsData.length > 10 && (
                  <div style={{ marginTop: 12, fontSize: 12, color: "#8a7a66", textAlign: "center" }}>
                    Showing 10 of {shipmentsData.length}. <button onClick={() => setTab("shipments")} style={{ background: "none", border: "none", color: "#b5552b", cursor: "pointer", textDecoration: "underline" }}>View all in Shipments tab</button>
                  </div>
                )}
              </div>
            );
          }
        })()}
      </Panel>

      {drillDown && (
        <Modal onClose={() => setDrillDown(null)} width={620}>
          <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 4px", fontSize: 19 }}>
            {drillDown.label}
          </h3>
          <p style={{ fontSize: 12, color: "#8a7a66", margin: "0 0 16px" }}>
            Individual invoices contributing to this month's total.
          </p>
          {(() => {
            const allRows = getTransactionsForMonth(db.customers, drillDown.key);
            const rows = drillDown.filterCustomer
              ? allRows.filter(r => r.customerName === drillDown.filterCustomer)
              : allRows;
            const total = rows.reduce((s, r) => s + r.amount, 0);
            if (rows.length === 0) {
              return <p className="muted" style={{ fontSize: 13 }}>No transactions found for this month.</p>;
            }
            return (
              <>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid #b5552b" }}>
                        <th style={{ textAlign: "left", padding: "6px 8px", fontSize: 11, color: "#6b5240" }}>Customer</th>
                        <th style={{ textAlign: "left", padding: "6px 8px", fontSize: 11, color: "#6b5240" }}>Invoice #</th>
                        <th style={{ textAlign: "left", padding: "6px 8px", fontSize: 11, color: "#6b5240" }}>Product</th>
                        <th style={{ textAlign: "left", padding: "6px 8px", fontSize: 11, color: "#6b5240" }}>Date</th>
                        <th style={{ textAlign: "right", padding: "6px 8px", fontSize: 11, color: "#6b5240" }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid #f0e8d9" }}>
                          <td style={{ padding: "8px", color: "#4a3527" }}>{r.customerName}</td>
                          <td style={{ padding: "8px", color: "#4a3527" }}>{r.invoiceNumber}</td>
                          <td style={{ padding: "8px", color: "#4a3527" }}>{r.product}</td>
                          <td style={{ padding: "8px", color: "#4a3527" }}>{r.invoiceMonth}</td>
                          <td style={{ padding: "8px", color: "#4a3527", textAlign: "right", fontWeight: 600 }}>
                            ${r.amount.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ borderTop: "2px solid #b5552b", fontWeight: 700 }}>
                        <td colSpan={4} style={{ padding: "10px 8px", color: "#4a3527" }}>Total</td>
                        <td style={{ padding: "10px 8px", color: "#4a3527", textAlign: "right" }}>${total.toLocaleString()}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
                  <Btn variant="ghost" onClick={() => setDrillDown(null)}>Close</Btn>
                </div>
              </>
            );
          })()}
        </Modal>
      )}
    </section>
    </>
  );
}

function ShipmentsTab({ db, update, showToast, openRecord }) {
  const [editingShipment, setEditingShipment] = useState(undefined);
  const isMobile = useIsMobile();

  const allPOs = (db.pos || []).filter((po) => !po.consolidatedGroupId);  // Exclude member POs
  const shipmentsWithPayments = allPOs.map(po => {
    const paymentMilestones = po.paymentMilestones || [];
    const totalDue = paymentMilestones.reduce((sum, m) => sum + (parseFloat(m.amount) || 0), 0) || po.total || 0;
    const totalPaid = paymentMilestones.filter(m => m.paid).reduce((sum, m) => sum + (parseFloat(m.amount) || 0), 0);
    const amountOwed = totalDue - totalPaid;
    const nextPaymentDue = paymentMilestones.find(m => !m.paid && m.due);
    
    return {
      ...po,
      totalDue,
      totalPaid,
      amountOwed,
      nextPaymentDue: nextPaymentDue?.due,
      customsClearance: po.customsClearance || 0,
    };
  });

  return (
    <section>
      <div className="section-header">
        <h2 className="section-title">Shipments</h2>
        <p className="section-desc">Track supplier purchase orders, delivery dates, and payment schedules</p>
      </div>

      <div className="content-area">
        {shipmentsWithPayments.length === 0 ? (
          <Panel>
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>No purchase orders yet. Create one in the Purchase Orders section.</p>
          </Panel>
        ) : isMobile ? (
          <div>
            {shipmentsWithPayments.map(po => (
              <div key={po.id}>
                <button
                  onClick={() => setEditingShipment(editingShipment?.id === po.id ? undefined : po)}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "14px 4px", background: "none", border: "none", borderBottom: "1px solid #e3d8c6", cursor: "pointer", textAlign: "left" }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#4a3527" }}>PO #{po.number} · {po.party}</div>
                    <div style={{ fontSize: 12, color: "#8a7a66", marginTop: 2 }}>
                      {po.status} · {(po.totalDue || 0).toLocaleString("en-AU", { style: "currency", currency: "AUD" })}
                    </div>
                  </div>
                  <span style={{ color: "#b5552b", fontSize: 18 }}>{editingShipment?.id === po.id ? "▾" : "›"}</span>
                </button>
                {editingShipment?.id === po.id && (
                  <div style={{ padding: "12px 4px 16px", borderBottom: "2px solid #b5552b" }}>
                    {[
                      { label: "Supplier", value: po.party },
                      { label: "Customer", value: po.customer || "—" },
                      { label: "Status", value: po.status },
                      { label: "Total", value: (po.totalDue || 0).toLocaleString("en-AU", { style: "currency", currency: "AUD" }) },
                      { label: "Paid", value: (po.totalPaid || 0).toLocaleString("en-AU", { style: "currency", currency: "AUD" }) },
                      { label: "Owed", value: (po.amountOwed || 0).toLocaleString("en-AU", { style: "currency", currency: "AUD" }) },
                      po.customsClearance > 0 && { label: "Customs", value: po.customsClearance.toLocaleString("en-AU", { style: "currency", currency: "AUD" }) },
                      po.nextPaymentDue && { label: "Next due", value: new Date(po.nextPaymentDue).toLocaleDateString("en-AU") },
                    ].filter(Boolean).map((row, i) => (
                      <div key={i} style={{ display: "flex", gap: 12, padding: "7px 0", borderBottom: "1px solid #f0e8d9" }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#8a7a66", width: 68, flexShrink: 0 }}>{row.label}</span>
                        <span style={{ fontSize: 13, color: "#4a3527" }}>{row.value}</span>
                      </div>
                    ))}
                    {po.paymentMilestones?.length > 0 && (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#6b5240", marginBottom: 4 }}>Payment Schedule</div>
                        {po.paymentMilestones.map((m, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0", color: m.paid ? "#5c7a4f" : "#4a3527" }}>
                            <span>{m.paid ? "✓ " : ""}{m.due ? new Date(m.due).toLocaleDateString("en-AU") : "TBC"}</span>
                            <span style={{ fontWeight: 600 }}>{(parseFloat(m.amount) || 0).toLocaleString("en-AU", { style: "currency", currency: "AUD" })}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                      <Btn variant="primary" size="sm" onClick={() => openRecord && openRecord("po", po.id)}>Edit PO</Btn>
                      <Btn variant="ghost" size="sm" onClick={() => setEditingShipment(undefined)}>Close</Btn>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
              <thead>
                <tr style={{ background: "#f9f7f2" }}>
                  <th style={{ textAlign: "left", padding: "12px 8px", fontSize: 12, fontWeight: 700, borderBottom: "2px solid #b5552b" }}>PO #</th>
                  <th style={{ textAlign: "left", padding: "12px 8px", fontSize: 12, fontWeight: 700, borderBottom: "2px solid #b5552b" }}>Supplier</th>
                  <th style={{ textAlign: "left", padding: "12px 8px", fontSize: 12, fontWeight: 700, borderBottom: "2px solid #b5552b" }}>Status</th>
                  <th style={{ textAlign: "left", padding: "12px 8px", fontSize: 12, fontWeight: 700, borderBottom: "2px solid #b5552b" }}>Next Payment Due</th>
                  <th style={{ textAlign: "right", padding: "12px 8px", fontSize: 12, fontWeight: 700, borderBottom: "2px solid #b5552b" }}>Total</th>
                  <th style={{ textAlign: "right", padding: "12px 8px", fontSize: 12, fontWeight: 700, borderBottom: "2px solid #b5552b" }}>Paid</th>
                  <th style={{ textAlign: "right", padding: "12px 8px", fontSize: 12, fontWeight: 700, borderBottom: "2px solid #b5552b" }}>Owed</th>
                  <th style={{ textAlign: "right", padding: "12px 8px", fontSize: 12, fontWeight: 700, borderBottom: "2px solid #b5552b" }}>Customs</th>
                </tr>
              </thead>
              <tbody>
                {shipmentsWithPayments.map(po => (
                  <tr 
                    key={po.id}
                    onClick={() => setEditingShipment(po)}
                    style={{ 
                      cursor: "pointer", 
                      borderBottom: "1px solid #e3d8c6",
                      background: editingShipment?.id === po.id ? "#ede8de" : "transparent"
                    }}
                    onMouseOver={(e) => e.currentTarget.style.background = "#f9f7f2"}
                    onMouseOut={(e) => e.currentTarget.style.background = editingShipment?.id === po.id ? "#ede8de" : "transparent"}
                  >
                    <td style={{ padding: "12px 8px", fontSize: 13, color: "#4a3527", fontWeight: 600 }}>#{po.number}</td>
                    <td style={{ padding: "12px 8px", fontSize: 13, color: "#4a3527" }}>{po.party}</td>
                    <td style={{ padding: "12px 8px", fontSize: 13, color: "#4a3527" }}>
                      <span style={{ 
                        display: "inline-block",
                        background: po.status === "Received" ? "#e8f5e0" : "#fff3e0",
                        color: po.status === "Received" ? "#5c7a4f" : "#8a6d3b",
                        padding: "4px 8px",
                        borderRadius: "4px",
                        fontSize: "11px",
                        fontWeight: 600
                      }}>
                        {po.status}
                      </span>
                    </td>
                    <td style={{ padding: "12px 8px", fontSize: 13, color: "#4a3527" }}>
                      {po.nextPaymentDue ? new Date(po.nextPaymentDue).toLocaleDateString() : "—"}
                    </td>
                    <td style={{ padding: "12px 8px", fontSize: 13, color: "#4a3527", textAlign: "right", fontWeight: 600 }}>
                      {(po.totalDue || 0).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })}
                    </td>
                    <td style={{ padding: "12px 8px", fontSize: 13, color: "#5c7a4f", textAlign: "right" }}>
                      {(po.totalPaid || 0).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })}
                    </td>
                    <td style={{ padding: "12px 8px", fontSize: 13, color: po.amountOwed > 0 ? "#a3442e" : "#5c7a4f", textAlign: "right", fontWeight: 600 }}>
                      {(po.amountOwed || 0).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })}
                    </td>
                    <td style={{ padding: "12px 8px", fontSize: 13, color: "#4a3527", textAlign: "right" }}>
                      {(po.customsClearance || 0).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {editingShipment && !isMobile && (
          <Panel style={{ marginTop: 24 }}>
            <h3 style={{ fontFamily: "Georgia,serif", color: "#4a3527", margin: "0 0 16px", fontSize: 16 }}>
              PO #{editingShipment.number} Details
            </h3>
            
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 24 }}>
              <div>
                <h4 style={{ fontSize: 12, fontWeight: 600, color: "#6b5240", margin: "0 0 12px" }}>Order Info</h4>
                <div style={{ fontSize: 13, lineHeight: 1.8, color: "#4a3527" }}>
                  <div><strong>Supplier:</strong> {editingShipment.party}</div>
                  <div><strong>Date:</strong> {editingShipment.date}</div>
                  <div><strong>Status:</strong> {editingShipment.status}</div>
                  <div><strong>Contact:</strong> {editingShipment.contact || "—"}</div>
                </div>
              </div>

              <div>
                <h4 style={{ fontSize: 12, fontWeight: 600, color: "#6b5240", margin: "0 0 12px" }}>Payment Summary</h4>
                <div style={{ fontSize: 13, lineHeight: 1.8, color: "#4a3527" }}>
                  <div><strong>Total Due:</strong> {(editingShipment.totalDue || 0).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })}</div>
                  <div><strong>Total Paid:</strong> {(editingShipment.totalPaid || 0).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })}</div>
                  <div style={{ paddingTop: 8, borderTop: "1px solid #e3d8c6", marginTop: 8 }}>
                    <strong style={{ color: editingShipment.amountOwed > 0 ? "#a3442e" : "#5c7a4f" }}>
                      Amount Owed: {(editingShipment.amountOwed || 0).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })}
                    </strong>
                  </div>
                </div>
              </div>
            </div>

            {editingShipment.customsClearance > 0 && (
              <div style={{ background: "#fef5e7", border: "1px solid #f9e79f", borderRadius: 6, padding: 12, marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: "#8a6d3b" }}>
                  <strong>Estimated Customs Clearance:</strong> {editingShipment.customsClearance.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })}
                </div>
              </div>
            )}

            {editingShipment.paymentMilestones && editingShipment.paymentMilestones.length > 0 && (
              <div>
                <h4 style={{ fontSize: 12, fontWeight: 600, color: "#6b5240", margin: "0 0 12px" }}>Payment Schedule</h4>
                <div style={{ background: "#f9f7f2", border: "1px solid #d3c9b8", borderRadius: 6, padding: 12 }}>
                  {editingShipment.paymentMilestones.map((m, idx) => (
                    <div key={idx} style={{ 
                      display: "flex", 
                      justifyContent: "space-between", 
                      alignItems: "center",
                      padding: "8px 0",
                      borderBottom: idx < editingShipment.paymentMilestones.length - 1 ? "1px solid #e3d8c6" : "none",
                      fontSize: 13
                    }}>
                      <div>
                        <span style={{ color: "#6b5240" }}>Due: {new Date(m.due).toLocaleDateString()}</span>
                        {m.paid && <span style={{ color: "#5c7a4f", marginLeft: 12 }}>✓ Paid {m.paidDate ? new Date(m.paidDate).toLocaleDateString() : ""}</span>}
                      </div>
                      <span style={{ fontWeight: 600, color: m.paid ? "#5c7a4f" : "#4a3527" }}>
                        {(parseFloat(m.amount) || 0).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <Btn variant="primary" size="sm" onClick={() => openRecord && openRecord("po", editingShipment.id)}>Edit PO</Btn>
              <button
                onClick={() => setEditingShipment(undefined)}
                style={{ background: "none", border: "none", color: "#8a7a66", cursor: "pointer", fontSize: 13, textDecoration: "underline" }}
              >
                Close
              </button>
            </div>
          </Panel>
        )}
      </div>
    </section>
  );
}