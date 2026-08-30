import { useState } from 'react';

interface Props {
  onSubmit: (params: {
    url: string;
    pages: number;
    depth: number;
    device: string;
    network: string;
    ai: boolean;
    interactions: boolean;
  }) => void;
}

export default function AuditForm({ onSubmit }: Props) {
  const [url, setUrl] = useState('');
  const [pages, setPages] = useState(25);
  const [depth, setDepth] = useState(2);
  const [device, setDevice] = useState('DESKTOP');
  const [network, setNetwork] = useState('FAST');
  const [ai, setAi] = useState(true);
  const [interactions, setInteractions] = useState(true);
  const [showOptions, setShowOptions] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = url.startsWith('http') ? url : `https://${url}`;
    onSubmit({ url: normalized, pages, depth, device, network, ai, interactions });
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[80vh] gap-8 px-2">
      <div className="text-center">
        <h1 className="text-4xl sm:text-6xl font-bold mb-4 bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
          Audit any website
        </h1>
        <p className="text-gray-400 text-base sm:text-xl">
          Functional · Performance · Accessibility · SEO · Security · UI/UX
        </p>
      </div>

      <form onSubmit={handleSubmit} className="w-full max-w-3xl flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="yoursite.com"
            required
            className="flex-1 bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-lg focus:outline-none focus:border-indigo-500 transition-colors placeholder-gray-600"
          />
          <button
            type="submit"
            className="w-full sm:w-auto px-8 py-4 bg-indigo-600 hover:bg-indigo-500 rounded-2xl text-lg font-semibold transition-colors"
          >
            Run Audit
          </button>
        </div>

        <button
          type="button"
          onClick={() => setShowOptions(!showOptions)}
          className="text-base text-gray-500 hover:text-gray-300 transition-colors self-start"
        >
          {showOptions ? '▲ Hide options' : '▼ Show options'}
        </button>

        {showOptions && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex flex-col gap-2">
              <span className="text-sm text-gray-400 uppercase tracking-wide font-medium">Max pages</span>
              <input
                type="number"
                min={1}
                max={100}
                value={pages}
                onChange={(e) => setPages(Number(e.target.value))}
                className="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-indigo-500"
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-sm text-gray-400 uppercase tracking-wide font-medium">Max depth</span>
              <input
                type="number"
                min={1}
                max={5}
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value))}
                className="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-indigo-500"
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-sm text-gray-400 uppercase tracking-wide font-medium">Device</span>
              <select
                value={device}
                onChange={(e) => setDevice(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-indigo-500"
              >
                <option value="DESKTOP">Desktop</option>
                <option value="MOBILE">Mobile</option>
              </select>
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-sm text-gray-400 uppercase tracking-wide font-medium">Network</span>
              <select
                value={network}
                onChange={(e) => setNetwork(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-indigo-500"
              >
                <option value="FAST">Fast</option>
                <option value="FAST_4G">Fast 4G</option>
                <option value="SLOW_4G">Slow 4G</option>
              </select>
            </label>

            <label className="flex items-center gap-4 cursor-pointer">
              <input
                type="checkbox"
                checked={ai}
                onChange={(e) => setAi(e.target.checked)}
                className="w-5 h-5 accent-indigo-500"
              />
              <span className="text-base text-gray-300">AI enrichment</span>
            </label>

            <label className="flex items-center gap-4 cursor-pointer">
              <input
                type="checkbox"
                checked={interactions}
                onChange={(e) => setInteractions(e.target.checked)}
                className="w-5 h-5 accent-indigo-500"
              />
              <span className="text-base text-gray-300">Interaction testing</span>
            </label>
          </div>
        )}
      </form>

      <div className="flex flex-wrap justify-center gap-4 text-sm text-gray-600">
        {['Functional', 'Performance', 'Accessibility', 'SEO', 'Security'].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  );
}
