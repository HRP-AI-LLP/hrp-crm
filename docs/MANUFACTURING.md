# Manufacturing

Manufacturing is a built-in app (Settings → Apps). It needs Inventory and Purchasing. It covers:

- discrete and make-to-order production;
- process and batch production;
- job work and subcontracting under GST;
- planning (MRP);
- quality checks;
- batch and expiry tracking.

When Synapse keeps the books, every step posts to the ledger.

Switching it on adds two records, **Work orders** and **Job work**, and two roles:

- **Production manager:** bills of materials, work orders, job work, quality, MRP and stock.
- **Shop floor:** works on released work orders.

## Products

Products gain these fields:

- **Make or buy**: buy, make, or both.
- **Preferred vendor**, **lead time (days)**, **safety stock** and **minimum order quantity**. MRP uses these.
- **Batch tracked** and **shelf life (days)**.

## Work centres

A work centre is a machine, line or team. It has:

- hours per day and days per week;
- the number of machines or people working in parallel;
- a **cost per hour** for labour and overhead.

Routing time is charged at that cost. Hours, days and parallel units set the weekly capacity.

## Bills of materials

- **Kinds:**
  - discrete (assemble or fabricate);
  - process or batch (a recipe or formula);
  - kit.
- **What a bill of materials holds:**
  - **Batch size:** "makes 1", or "makes 500 kg".
  - **Yield %.**
  - **Components**, each with its own scrap %. A component can be linked to the operation where it is used.
  - **By-products**, which take a share of the cost.
  - **Routing:** operations, each with a work centre, setup minutes and minutes per unit. An operation can be marked as done by a job worker.
  - **Final QC required:** output cannot be recorded until a final inspection has passed that quantity. Final inspections are recorded by quality or production managers, not the shop floor.
- **Multi-level:** a component that has its own active bill of materials is a sub-assembly.
  - **Standard cost** rolls up through sub-assemblies, after scrap, yield and by-products.
  - **Explode** lists everything needed for any quantity.
  - **Where used** lists the bills of materials that use a component.
- **Loops are refused:** a product cannot be made from something that is made from it.
- **Versions:**
  - Bills of materials are versioned. Only drafts can be edited.
  - To change an active one, choose **New version**, edit the draft, then activate it.
  - One active version per product is the default.

## Work orders

A work order moves through these statuses:

**Draft** → **Released** → **In progress** → **Completed** → **Closed** (or **Cancelled**)

- **Release:**
  - Builds the order's material list and routing from its bill of materials, scaled for quantity, yield and scrap.
  - After release, the product, quantity, bill of materials and warehouse are frozen.
- **Issue material:**
  - Issue all remaining material, or chosen quantities.
  - Material is valued at moving-average cost: Dr Work in progress, Cr Stock.
  - Batch-tracked items are taken first-expiry-first-out, or from a lot you choose.
  - Quarantined and rejected lots are never used. Stock reserved for sales orders is not taken.
  - Unused material can be returned to stock at the order's issue cost.
- **Log time** on an operation:
  - Time is charged at the work centre rate: Dr Work in progress, Cr Manufacturing overheads absorbed.
  - Each entry records the operator, the quantity done and whether the operation is finished.
- **Record output:**
  - Material must have been issued first.
  - Enter the good quantity and any scrap.
  - Work in progress is relieved in proportion. The last output takes everything left.
  - By-products come into stock at their cost share. Scrap goes to Scrap and production losses.
  - Finished goods come into stock at the actual cost, and the product's moving-average cost is updated.
  - Batch-tracked output gets a lot:
    - The lot number is the one given, the order's lot, or one generated from the order number.
    - Expiry defaults to today plus the product's shelf life.
    - The lot is linked to every lot consumed, for traceability.
  - **Make-to-order:**
    - An order linked to a sales order reserves its output for that sales order.
    - Confirming a sales order for a made item reserves only what is on the shelf; production reserves the rest.
- **Close:** whatever is left in work in progress is booked as a production variance (Inventory adjustments).
- **Cancel:** only possible while nothing is issued, logged or produced.
- **Delete:** only drafts and cancelled orders can be deleted.

The order page shows material, labour and overhead, work in progress, standard against actual unit cost, and the variance.

## Batches, expiry and traceability

The **Batches & expiry** tab lists lots with days to expiry and their status (available, quarantine or rejected).

- **Register a batch** for stock you already hold, such as received or opening stock.
- Lots never add up to more than the stock on hand. Stock that leaves another way, such as a shipment or an adjustment, comes off the lots first-expiry-first-out.
- **Trace** shows both directions:
  - backward: what a lot was made from, through every level;
  - forward: what it went into.

## Quality

Inspections can be incoming, in process or final. Each records:

- quantity inspected and rejected;
- the result: pass, hold or fail;
- up to 50 parameters (check, spec, measured value, ok);
- notes.

When an inspection on a lot is put on hold, the lot goes into quarantine. When one fails, the lot is rejected. Either way, production stops using that lot.

## Job work (subcontracting)

1. Create a **Job work** with:
   - the job worker (a vendor);
   - the process;
   - what comes back and the expected quantity;
   - the rate per unit.
2. List the goods to send.
3. **Send** the goods:
   - The job work gets a delivery challan number (`DC/yy-yy/nnnn`).
   - Stock leaves the warehouse: Dr Material with job workers, Cr Stock.
   - **Print challan** prints a GST delivery challan (section 143). It has HSN codes, values and the job worker's GSTIN.
4. **Receive back:**
   - Record the processed quantity (up to the expected quantity plus 10%) and the job worker's challan number.
   - Material used is taken in proportion. It can be overridden.
   - Unprocessed goods can come back as they are.
   - Processed goods come into stock at the material cost plus rate × quantity: Dr Stock, Cr Material with job workers, Cr Job work charges.
   - The job worker's bill settles the charge.
   - Receipts against a work order operation update that operation's progress.
5. **Close:** anything still with the job worker is written off as process loss.

**ITC-04** (Job work & ITC-04 tab) shows:

- challans sent and goods received back for any period, downloadable as CSV;
- inputs that have been out for more than 300 days. Inputs not returned within a year are treated as a supply (rule 45).

## Planning (MRP)

**Run MRP** for a horizon of up to 365 days.

- **Demand:**
  - open sales order lines due in the horizon;
  - material still to be issued on released work orders, and the components of draft work orders;
  - safety stock;
  - optionally, top-ups to reorder levels.
- **Supply:**
  - stock on hand;
  - open purchase orders;
  - work orders still to finish.
- **How it plans:**
  - Products are netted level by level, so a component is planned after everything that uses it.
  - Made items that are short explode into demand for their components.
  - Suggestions respect the minimum order quantity.
  - The order-by date is the need-by date minus the lead time.
- **What it suggests:** a **buy** or **make** action per item, with the quantities and dates behind it.
- **Acting on suggestions:**
  - Select lines and **Create orders**. Buy lines become draft purchase orders, one per vendor. Make lines become draft work orders.
  - Lines can also be ignored.

## Reports

- **Overview:**
  - open and late work orders;
  - work in progress value;
  - output and scrap this month;
  - material with job workers;
  - quality pass rate;
  - batches expiring within 30 days.
- **Work centre load:** hours of open work by week against weekly capacity, with overloads highlighted.
- **Production cost:** finished orders with scrap %, material and operations, standard against actual unit cost, and variance.

## Permissions

| Who | Can |
|---|---|
| `manufacturing` admin area (Production manager) | Everything, including bills of materials, work centres, MRP, final inspections and batch status |
| Inventory managers and operations (added when the app is switched on) | Create, release, run, close and cancel work orders; job work; final inspections and batch status (operations admin) |
| Shop floor | Work released orders: issue and return material, log time, record output, and inspect the order's own materials and batches. Cannot release, close or cancel, or certify final QC |
| Sales reps and managers, read-only | See work orders without costs; sales managers also see job work |
| Accounts | See work orders and job work |
| Technicians and service agents | No access |
| ITC-04 | Manufacturing, books or billing admins |

Costs (material, labour, WIP, standard and actual cost, variance and work centre rates) are shown only to manufacturing, operations and books admins, and to people who can see and edit product cost prices.

## API

Everything is under `/api/v1/mfg`:

- `/overview`, `/reports/load`, `/reports/production`, `/reports/itc04`
- `/work-centers`
- `/boms`, `/boms/:id` (`/status`, `/copy`, `/explode`), `/where-used/:productId`
- `/work-orders/:id` (`/release`, `/issue`, `/return`, `/operations/:opId`, `/produce`, `/close`, `/cancel`)
- `/lots`, `/lots/:id/status`, `/lots/:id/trace`
- `/quality`
- `/job-works/:id` (`/lines`, `/send`, `/receive`, `/close`)
- `/mrp`, `/mrp/run`, `/mrp/:runId/act`, `/mrp/:runId/ignore`

Work orders and job work are created and edited as records (`/api/v1/records/work_order`, `/api/v1/records/job_work`). The delivery challan prints at `/print/job_work/:id`.
