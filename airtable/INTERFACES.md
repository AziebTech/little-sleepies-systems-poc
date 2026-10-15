# Airtable interfaces by team

A build guide for the Production, Photography and Compliance & Integrity interfaces. Every field below already exists in the base: it was created by `setup_product_model.py`, or added by hand where marked *(hand-added)*. Fields that don't exist yet are listed under **Gaps** at the end of each team's section.

**Rules for every interface**
- ✎ = editable in the interface. Every other field is read-only.
- Fields written by the integrations (LS-01, LS-02, LS-06) are always read-only. See [SCHEMA.md](SCHEMA.md#fields-the-integrations-own-on-colorways).
- Use the interface's relative date filters ("within the next N days", "N days ago") instead of adding formula fields just for filtering.
- Pages appear in the left sidebar. The first page is where people land.

---

## Production

Production owns colorways and samples. They chase factories and other teams, and they place POs. Launch milestone: pre-production sample approved at T-90.

### 1. Sample pipeline (Kanban)
The overview of where every sample is.

| Setting | Value |
|---|---|
| Source | Samples |
| Group by | Status: Requested → Received → Approved / Rejected |
| Sort | Requested Date, oldest first |
| Card fields | Sample, Colorway, Round, Requested Date, Received Date |

### 2. Samples to decide (Record review)
The daily queue. A sample drops off the list once it's decided.

| Setting | Value |
|---|---|
| Source | Samples |
| Filter | Status is Received |
| Sort | Received Date, oldest first |
| List | Sample, Colorway, Round |
| Detail | Colorway, Round, Received Date, Status ✎, Decision Date ✎, Comments ✎ |

### 3. Launches at risk (List)
Which launches are slipping, and whether the stock will arrive in time.

| Setting | Value |
|---|---|
| Source | Colorways |
| Filter | Timeline Status is any of At Risk, Late; and Production Status is not Cancelled |
| Sort | Launch Date, soonest first |
| Fields | Colorway, Launch Date, Timeline Status, Next Milestone, Next Due Date, Days Late, Factory, PO Number, Vendor, PO Qty, Expected Delivery, PO Status |
| Detail | Critical Path (the full milestone list from LS-06) |

### 4. Missing data before approval (List)
Fixes these before they fail at the ERP sync.

| Setting | Value |
|---|---|
| Source | Colorways |
| Filter | Production Status is In Development; and any of: Colorway Number, Cost Price, Factory or Launch Date is empty |
| Sort | Launch Date, soonest first |
| Fields | Colorway, Style, Print, Colorway Number ✎, Cost Price ✎, Factory ✎, Launch Date ✎, Production Status ✎ |

### Gaps
- **Expected Date** on Samples (date): when the factory should send the sample back. Without it, you can't tell when a sample is late.
- **Will Miss Launch** on Colorways (formula): `IF(AND({Expected Delivery}, {Expected Delivery} > {Launch Date}), "Will miss launch")`. Add it to page 3.
- **Sample Photos** on Samples (attachment): fit and markup photos. Use it as the Kanban card cover.

---

## Photography

Photography owns the shot list and needs the physical samples. Launch milestone: photography delivered at T-30.

### 1. Shot board (Kanban)

| Setting | Value |
|---|---|
| Source | Photo Shots |
| Group by | Status: Planned → Shot → In Retouch → Delivered |
| Card fields | Shot, Colorway, Shot Type, Shoot Date, Model Size |
| Editable | Status ✎ (drag a card to change it), Shoot Date ✎, Delivered Date ✎, Model Size ✎, DAM Asset ID ✎ |

### 2. This week's shoots (Calendar)

| Setting | Value |
|---|---|
| Source | Photo Shots |
| Date field | Shoot Date |
| Filter | Status is Planned |
| Detail | Shot, Colorway, Shot Type, Model Size, Status ✎ |

### 3. Launching soon without photos (List)
The page that tightens timelines. It gives two weeks' warning before the T-30 photo deadline.

| Setting | Value |
|---|---|
| Source | Colorways |
| Filter | Launch Date is within the next 45 days; and Photo Status is not Complete; and Production Status is not Cancelled |
| Sort | Launch Date, soonest first |
| Fields | Colorway, Launch Date, Photo Status, Timeline Status, Next Milestone, Photo Shots (linked) |

### 4. Samples ready to shoot (List)
Which physical samples exist and are approved.

| Setting | Value |
|---|---|
| Source | Samples |
| Filter | Status is Approved; and Round is any of Pre-Production, Top of Production |
| Sort | Decision Date, newest first |
| Fields | Sample, Colorway, Round, Decision Date, Comments |

### Gaps
- **Photo Due** on Colorways (formula): `DATEADD({Launch Date}, -30, 'days')`. Photography's own deadline, which is clearer than Next Due Date because that one only shows the *next* milestone.
- **Sample Location** on Samples (single select: At Factory, In Transit, Production, Photo Studio): where the physical sample is right now. Photography constantly asks this.

---

## Compliance & Integrity

Compliance & Integrity owns the test results. Which tests each colorway needs comes from its style's Compliance Profile. Launch milestone: compliance passed at T-60.

### 1. Test board (Kanban)

| Setting | Value |
|---|---|
| Source | Compliance Tests |
| Group by | Status: Not Started → Submitted → Passed / Failed / Not Applicable |
| Card fields | Test, Colorway, Test Type, Lab, Submitted Date |

### 2. Waiting on the lab (List)
Tests to chase the lab about.

| Setting | Value |
|---|---|
| Source | Compliance Tests |
| Filter | Status is Submitted; and Submitted Date is before 10 days ago |
| Sort | Submitted Date, oldest first |
| Fields | Test, Colorway, Test Type, Lab, Submitted Date, Status ✎, Result Date ✎, Report Link ✎ |

### 3. Failed tests (Record review)

| Setting | Value |
|---|---|
| Source | Compliance Tests |
| Filter | Status is Failed |
| Sort | Result Date, newest first |
| Detail | Colorway, Test Type, Lab, Result Date, Report Link, Status ✎ (set to Submitted when it's retested) |

### 4. Colorway compliance (List)

| Setting | Value |
|---|---|
| Source | Colorways |
| Filter | Production Status is not Cancelled; and Compliance (formula) is not Passed |
| Sort | Launch Date, soonest first |
| Fields | Colorway, Style, Launch Date, Required Tests *(hand-added)*, Tests Passed (rollup) *(hand-added)*, Compliance (formula) *(hand-added)*, Compliance Status (LS-06), Compliance Tests (linked) |

### Gaps
- **Compliance Profile** and **Fiber Content** on Colorways (lookups through Style). Compliance needs both, and today they're only on Style Master.
- **Tests Total (rollup)** and **Tests Failed (rollup)** on Colorways, so the compliance formula can return Not Started and Failed.
- A **Profile Tests** table plus an automation that creates the required test rows when a colorway is created. Then nobody has to type test rows in by hand.

---

## Systems (your own page)

Not for the three teams: this one is for whoever owns the integrations.

| Setting | Value |
|---|---|
| Source | Colorways |
| Filter | Sync Status is Error |
| Fields | Colorway, SKU Base, Sync Status, Last Sync Error, Last Synced At, ERP Item Code |

To retry after the data is fixed, set Sync Status to Pending (see [RUNBOOK.md](../docs/RUNBOOK.md)).
