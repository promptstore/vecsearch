import { Hits, InstantSearch, SearchBox } from 'react-instantsearch-hooks-web';

import 'instantsearch.css/themes/satellite.css';

import {
  searchClient,
} from './searchSlice';

function Hit({ hit }) {
  return (
    <div style={{ textAlign: 'left' }}>
      <div style={{ fontWeight: 600 }}>{hit.name}</div>
      <div style={{ fontSize: '0.8em' }}>{hit.description}</div>
    </div>
  );
}

export function SearchResults() {
  return (
    <div style={{
      margin: '20px auto',
      width: 600,
    }}>
      <InstantSearch searchClient={searchClient} indexName="instant_search">
        <SearchBox />
        <Hits hitComponent={Hit} />
      </InstantSearch>
    </div>
  );
}
