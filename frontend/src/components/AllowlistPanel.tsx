import { useEffect, useState } from "react";
import { getAllowlist, addToAllowlist, removeFromAllowlist } from "../services/allowlistService";

export function AllowlistPanel() {
  const [addresses, setAddresses] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const limit = 50;
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(p = page) {
    setLoading(true);
    setError(null);
    try {
      const res = await getAllowlist(p, limit);
      setAddresses(res.data);
      setTotal(res.total);
      setPage(res.page);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(1); }, []);

  async function handleAdd() {
    setError(null);
    try {
      await addToAllowlist(input.trim());
      setInput("");
      load(page);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleRemove(address: string) {
    setError(null);
    try {
      await removeFromAllowlist(address);
      load(page);
    } catch (e: any) {
      setError(e.message);
    }
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <div>
      <h2>Allowlist ({total})</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <div>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Stellar public key (G...)"
          style={{ width: "360px" }}
        />
        <button onClick={handleAdd} disabled={!input.trim()}>Add</button>
      </div>
      {loading ? (
        <p>Loading...</p>
      ) : (
        <ul>
          {addresses.map(addr => (
            <li key={addr}>
              {addr}
              <button onClick={() => handleRemove(addr)} style={{ marginLeft: "8px" }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {totalPages > 1 && (
        <div>
          <button onClick={() => load(page - 1)} disabled={page <= 1}>Prev</button>
          <span> Page {page} / {totalPages} </span>
          <button onClick={() => load(page + 1)} disabled={page >= totalPages}>Next</button>
        </div>
      )}
    </div>
  );
}
