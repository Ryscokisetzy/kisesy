import { readFileSync, readdirSync } from 'fs';

const API_URL = 'https://qrcoin.fun/api/airdrop/claim';
const API_KEY = '7928227064ff5fbd952120a972e3887d0dc88e9186a21e8c2ced7aa68068fd1c';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function claimAirdrop(account) {
  try {
    const payload = {
      fid: parseInt(account.fid),
      address: account.ethAddress,
      hasNotifications: true,
      username: account.username
    };

    console.log(`   Making claim request...`);
    
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'content-type': 'application/json',
        'origin': 'https://qrcoin.fun',
        'referer': 'https://qrcoin.fun/',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'x-api-key': API_KEY
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    
    if (response.ok && data.success) {
      return {
        success: true,
        txHash: data.tx_hash,
        message: data.message
      };
    } else {
      return {
        success: false,
        error: data.message || data.error || 'Unknown error'
      };
    }
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

function loadAccounts() {
  const accounts = [];
  
  try {
    const files = readdirSync('accounts').filter(file => file.endsWith('.json'));
    
    for (const file of files) {
      try {
        const accountData = JSON.parse(readFileSync(`accounts/${file}`, 'utf8'));
        
        accounts.push({
          fid: accountData.fid,
          username: accountData.username,
          ethAddress: accountData.custody.address,
          filename: file
        });
      } catch (error) {
        console.log(`⚠️ Failed to load ${file}: ${error.message}`);
      }
    }
  } catch (error) {
    console.log('❌ Failed to read accounts directory:', error.message);
    return [];
  }
  
  return accounts;
}

async function main() {
  console.log('🪙 Starting QR Coin airdrop claiming for all accounts...\n');
  
  const accounts = loadAccounts();
  
  if (accounts.length === 0) {
    console.log('ℹ️ No accounts found.');
    return;
  }
  
  console.log(`Found ${accounts.length} accounts to claim airdrops:\n`);
  
  let successCount = 0;
  let failureCount = 0;
  const results = [];
  
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    
    console.log(`🪙 [${i + 1}/${accounts.length}] Claiming for @${account.username} (FID: ${account.fid})`);
    console.log(`   Address: ${account.ethAddress}`);
    
    try {
      const result = await claimAirdrop(account);
      
      if (result.success) {
        console.log(`   ✅ Success: ${result.message}`);
        console.log(`   🔗 TX Hash: ${result.txHash}`);
        successCount++;
        
        results.push({
          username: account.username,
          fid: account.fid,
          status: 'success',
          txHash: result.txHash,
          message: result.message
        });
      } else {
        console.log(`   ❌ Failed: ${result.error}`);
        failureCount++;
        
        results.push({
          username: account.username,
          fid: account.fid,
          status: 'failed',
          error: result.error
        });
      }
      
      // Add delay between claims to avoid rate limits
      if (i < accounts.length - 1) {
        console.log('   ⏳ Waiting 2 seconds...\n');
        await sleep(2000);
      }
      
    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
      failureCount++;
      
      results.push({
        username: account.username,
        fid: account.fid,
        status: 'error',
        error: error.message
      });
    }
  }
  
  console.log('\n📊 Claiming Summary:');
  console.log(`   ✅ Successful: ${successCount}`);
  console.log(`   ❌ Failed: ${failureCount}`);
  console.log(`   📊 Total: ${accounts.length}`);
  
  if (successCount > 0) {
    console.log('\n🎉 Successful Claims:');
    results.filter(r => r.status === 'success').forEach(r => {
      console.log(`   @${r.username} - ${r.txHash}`);
    });
  }
  
  if (failureCount > 0) {
    console.log('\n❌ Failed Claims:');
    results.filter(r => r.status === 'failed' || r.status === 'error').forEach(r => {
      console.log(`   @${r.username} - ${r.error}`);
    });
  }
}

main().catch(console.error);