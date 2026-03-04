export default function LogoutPage({ onConfirm, onCancel }) {
  return (
    <div className="authPage">
      <div className="authCard card" aria-label="Logout">
        <div className="cardHeader">
          <div className="cardTitle">Logout</div>
          <div className="cardSubtitle">Are you sure you want to log out?</div>
        </div>

        <div className="authBody">
          <div className="authActions authActionsRow">
            <button className="btn btnGhost" type="button" onClick={onCancel}>
              Cancel
            </button>
            <button className="btn btnPrimary" type="button" onClick={onConfirm}>
              Logout
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
