import { NobleEd25519Signer, makeLinkAdd, makeLinkRemove, getSSLHubRpcClient, FarcasterNetwork } from '@farcaster/hub-nodejs';
import { readFileSync, readdirSync } from 'fs';

const HUB = 'crackle.farcaster.xyz:3383';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadAccounts() {
  const accounts = [];
  
  try {
    const files = readdirSync('accounts').filter(file => file.endsWith('.json'));
    
    for (const file of files) {
      try {
        const accountData = JSON.parse(readFileSync(`accounts/${file}`, 'utf8'));
        
        // Use primary signer if available, otherwise additional signer
        const signerKey = accountData.primarySigner?.privateKey || 
                         accountData.additionalSigner?.ed25519PrivateKey;
        
        if (signerKey) {
          accounts.push({
            fid: parseInt(accountData.fid),
            username: accountData.username,
            signerPrivateKey: signerKey,
            filename: file
          });
        }
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

async function followUser(fid, ed25519PrivHex, targetFid) {
  try {
    const cleanPrivKey = ed25519PrivHex.replace(/^0x/, '');
    const signer = new NobleEd25519Signer(Buffer.from(cleanPrivKey, 'hex'));
    const dataOptions = { fid: Number(fid), network: FarcasterNetwork.MAINNET };

    const msg = await makeLinkAdd(
      { type: 'follow', targetFid: Number(targetFid) },
      dataOptions,
      signer
    );
    
    if (msg.isErr()) {
      return { success: false, error: msg.error };
    }

    const hub = getSSLHubRpcClient(HUB);
    const res = await hub.submitMessage(msg.value);
    hub.close();

    if (res.isErr()) {
      return { success: false, error: res.error };
    }
    
    return { success: true, result: res.value };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function unfollowUser(fid, ed25519PrivHex, targetFid) {
  try {
    const cleanPrivKey = ed25519PrivHex.replace(/^0x/, '');
    const signer = new NobleEd25519Signer(Buffer.from(cleanPrivKey, 'hex'));
    const dataOptions = { fid: Number(fid), network: FarcasterNetwork.MAINNET };

    const msg = await makeLinkRemove(
      { type: 'follow', targetFid: Number(targetFid) },
      dataOptions,
      signer
    );
    
    if (msg.isErr()) {
      return { success: false, error: msg.error };
    }

    const hub = getSSLHubRpcClient(HUB);
    const res = await hub.submitMessage(msg.value);
    hub.close();

    if (res.isErr()) {
      return { success: false, error: res.error };
    }
    
    return { success: true, result: res.value };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function batchFollow(targetFids, delayMs = 2000) {
  console.log('👥 Starting batch follow operation...\n');
  
  const accounts = loadAccounts();
  
  if (accounts.length === 0) {
    console.log('ℹ️ No accounts found.');
    return;
  }

  console.log(`Found ${accounts.length} accounts`);
  console.log(`Target FIDs: ${targetFids.join(', ')}\n`);
  
  let totalOperations = accounts.length * targetFids.length;
  let successCount = 0;
  let failureCount = 0;
  let operationCount = 0;

  for (const account of accounts) {
    console.log(`🔄 Processing @${account.username} (FID: ${account.fid})`);
    
    for (const targetFid of targetFids) {
      operationCount++;
      console.log(`   [${operationCount}/${totalOperations}] Following FID ${targetFid}...`);
      
      const result = await followUser(account.fid, account.signerPrivateKey, targetFid);
      
      if (result.success) {
        console.log(`   ✅ Success`);
        successCount++;
      } else {
        console.log(`   ❌ Failed: ${result.error}`);
        failureCount++;
      }
      
      // Add delay between operations
      if (operationCount < totalOperations) {
        await sleep(delayMs);
      }
    }
    console.log('');
  }
  
  console.log('📊 Batch Follow Summary:');
  console.log(`   ✅ Successful: ${successCount}`);
  console.log(`   ❌ Failed: ${failureCount}`);
  console.log(`   📊 Total operations: ${totalOperations}`);
}

async function batchUnfollow(targetFids, delayMs = 2000) {
  console.log('👥 Starting batch unfollow operation...\n');
  
  const accounts = loadAccounts();
  
  if (accounts.length === 0) {
    console.log('ℹ️ No accounts found.');
    return;
  }

  console.log(`Found ${accounts.length} accounts`);
  console.log(`Target FIDs: ${targetFids.join(', ')}\n`);
  
  let totalOperations = accounts.length * targetFids.length;
  let successCount = 0;
  let failureCount = 0;
  let operationCount = 0;

  for (const account of accounts) {
    console.log(`🔄 Processing @${account.username} (FID: ${account.fid})`);
    
    for (const targetFid of targetFids) {
      operationCount++;
      console.log(`   [${operationCount}/${totalOperations}] Unfollowing FID ${targetFid}...`);
      
      const result = await unfollowUser(account.fid, account.signerPrivateKey, targetFid);
      
      if (result.success) {
        console.log(`   ✅ Success`);
        successCount++;
      } else {
        console.log(`   ❌ Failed: ${result.error}`);
        failureCount++;
      }
      
      // Add delay between operations
      if (operationCount < totalOperations) {
        await sleep(delayMs);
      }
    }
    console.log('');
  }
  
  console.log('📊 Batch Unfollow Summary:');
  console.log(`   ✅ Successful: ${successCount}`);
  console.log(`   ❌ Failed: ${failureCount}`);
  console.log(`   📊 Total operations: ${totalOperations}`);
}

async function singleFollow(accountFid, targetFid) {
  console.log(`👤 Single follow operation: FID ${accountFid} → FID ${targetFid}\n`);
  
  const accounts = loadAccounts();
  const account = accounts.find(acc => acc.fid === accountFid);
  
  if (!account) {
    console.log(`❌ Account with FID ${accountFid} not found`);
    return;
  }
  
  console.log(`Using account: @${account.username} (FID: ${account.fid})`);
  
  const result = await followUser(account.fid, account.signerPrivateKey, targetFid);
  
  if (result.success) {
    console.log(`✅ Successfully followed FID ${targetFid}`);
  } else {
    console.log(`❌ Failed to follow FID ${targetFid}: ${result.error}`);
  }
}

async function singleUnfollow(accountFid, targetFid) {
  console.log(`👤 Single unfollow operation: FID ${accountFid} → FID ${targetFid}\n`);
  
  const accounts = loadAccounts();
  const account = accounts.find(acc => acc.fid === accountFid);
  
  if (!account) {
    console.log(`❌ Account with FID ${accountFid} not found`);
    return;
  }
  
  console.log(`Using account: @${account.username} (FID: ${account.fid})`);
  
  const result = await unfollowUser(account.fid, account.signerPrivateKey, targetFid);
  
  if (result.success) {
    console.log(`✅ Successfully unfollowed FID ${targetFid}`);
  } else {
    console.log(`❌ Failed to unfollow FID ${targetFid}: ${result.error}`);
  }
}

function showHelp() {
  console.log('🔧 Follow Bot Usage:');
  console.log('');
  console.log('Available commands:');
  console.log('  batch-follow [fid1,fid2,...]     - All accounts follow specified FIDs');
  console.log('  batch-unfollow [fid1,fid2,...]   - All accounts unfollow specified FIDs');
  console.log('  follow [accountFid] [targetFid]  - Single account follows target');
  console.log('  unfollow [accountFid] [targetFid] - Single account unfollows target');
  console.log('  list                             - Show available accounts');
  console.log('  help                             - Show this help');
  console.log('');
  console.log('Examples:');
  console.log('  node follow.js batch-follow 12345,67890,11111');
  console.log('  node follow.js follow 1183183 12345');
  console.log('  node follow.js unfollow 1183183 12345');
}

function listAccounts() {
  console.log('📋 Available accounts:\n');
  
  const accounts = loadAccounts();
  
  if (accounts.length === 0) {
    console.log('ℹ️ No accounts found.');
    return;
  }
  
  accounts.forEach((account, index) => {
    console.log(`${index + 1}. @${account.username} (FID: ${account.fid})`);
  });
  
  console.log(`\nTotal: ${accounts.length} accounts`);
}

async function main() {
    await batchFollow([250749]);
//   const args = process.argv.slice(2);
  
//   if (args.length === 0) {
//     showHelp();
//     return;
//   }
  
//   const command = args[0].toLowerCase();
  
//   try {
//     switch (command) {
//       case 'batch-follow':
//         if (args.length < 2) {
//           console.log('❌ Please specify target FIDs: node follow.js batch-follow 12345,67890');
//           return;
//         }
//         const followTargets = args[1].split(',').map(fid => parseInt(fid.trim()));
//         await batchFollow(followTargets);
//         break;
        
//       case 'batch-unfollow':
//         if (args.length < 2) {
//           console.log('❌ Please specify target FIDs: node follow.js batch-unfollow 12345,67890');
//           return;
//         }
//         const unfollowTargets = args[1].split(',').map(fid => parseInt(fid.trim()));
//         await batchUnfollow(unfollowTargets);
//         break;
        
//       case 'follow':
//         if (args.length < 3) {
//           console.log('❌ Usage: node follow.js follow [accountFid] [targetFid]');
//           return;
//         }
//         await singleFollow(parseInt(args[1]), parseInt(args[2]));
//         break;
        
//       case 'unfollow':
//         if (args.length < 3) {
//           console.log('❌ Usage: node follow.js unfollow [accountFid] [targetFid]');
//           return;
//         }
//         await singleUnfollow(parseInt(args[1]), parseInt(args[2]));
//         break;
        
//       case 'list':
//         listAccounts();
//         break;
        
//       case 'help':
//       default:
//         showHelp();
//         break;
//     }
//   } catch (error) {
//     console.error('❌ Error:', error.message);
//   }
}

main().catch(console.error);