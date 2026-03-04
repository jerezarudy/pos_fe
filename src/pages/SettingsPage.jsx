export default function SettingsPage() {
  return (
    <div className="page">
      <div className="pageHeader">
        <h1 className="pageTitle">Settings</h1>
        <div className="pageSubtitle">Sample settings page</div>
      </div>

      <div className="grid">
        <section className="card" aria-label="Account">
          <div className="cardHeader">
            <div className="cardTitle">Account</div>
            <div className="cardSubtitle">Owner and security</div>
          </div>
          <div className="list">
            <div className="row">
              <div className="rowMain">
                <div className="rowTitle">Owner</div>
                <div className="rowSubtitle">jerezarudy22@gmail.com</div>
              </div>
            </div>
            <div className="row">
              <div className="rowMain">
                <div className="rowTitle">Two-factor auth</div>
                <div className="rowSubtitle">Add an extra layer of security.</div>
              </div>
              <label className="switch">
                <input type="checkbox" defaultChecked />
                <span className="switchTrack" aria-hidden="true" />
              </label>
            </div>
          </div>
        </section>

        <section className="card" aria-label="Features">
          <div className="cardHeader">
            <div className="cardTitle">Features</div>
            <div className="cardSubtitle">Enable or disable modules</div>
          </div>
          <div className="list">
            <div className="row">
              <div className="rowMain">
                <div className="rowTitle">Open tickets</div>
                <div className="rowSubtitle">
                  Save and edit orders before completing payment.
                </div>
              </div>
              <label className="switch">
                <input type="checkbox" />
                <span className="switchTrack" aria-hidden="true" />
              </label>
            </div>
            <div className="row">
              <div className="rowMain">
                <div className="rowTitle">Discounts</div>
                <div className="rowSubtitle">Apply discounts at checkout.</div>
              </div>
              <label className="switch">
                <input type="checkbox" defaultChecked />
                <span className="switchTrack" aria-hidden="true" />
              </label>
            </div>
            <div className="row">
              <div className="rowMain">
                <div className="rowTitle">Taxes</div>
                <div className="rowSubtitle">Configure tax rules.</div>
              </div>
              <label className="switch">
                <input type="checkbox" defaultChecked />
                <span className="switchTrack" aria-hidden="true" />
              </label>
            </div>
          </div>

          <div className="cardActions">
            <button className="btn btnGhost" type="button">
              Cancel
            </button>
            <button className="btn btnPrimary" type="button">
              Save
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

