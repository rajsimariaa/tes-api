async function test() {
  console.log('Testing Shoonya alternative domains...');

  const endpoints = [
    'https://api.shoonya.com/NorenWClientTP/QuickAuthenticate',
    'https://shoonyatrade.finvasia.com/NorenWClientTP/QuickAuthenticate'
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        },
        body: 'jData={}'
      });
      const text = await res.text();
      console.log(`URL: ${url}`);
      console.log(`Status: ${res.status}`);
      console.log(`Preview: ${text.substring(0, 150)}\n`);
    } catch (err) {
      console.error(`URL: ${url} error:`, err);
    }
  }
}

test();
