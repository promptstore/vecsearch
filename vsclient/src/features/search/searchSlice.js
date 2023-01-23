import axios from 'axios';

export const searchClient = {
  async search(requests) {
    const url = '/api/search/amazon_products';
    const res = await axios.post(url, { requests }, {
      headers: getHeaders(),
    });
    return res.data;
  },
  async searchForFacetValues(requests) {
    const url = '/api/sffv';
    const res = await axios.post(url, { requests }, {
      headers: getHeaders(),
    });
    return res.data;
  },
};

const getHeaders = () => ({
  'Accept': 'application/json',
  'Content-Type': 'application/json',
});
