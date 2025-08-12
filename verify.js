import {
  ViemLocalEip712Signer,
  NobleEd25519Signer,
  makeVerificationAddEthAddress,
  makeVerificationAddressClaim,
  hexStringToBytes,
  Protocol,
  FarcasterNetwork,
  getSSLHubRpcClient,
  getInsecureHubRpcClient,
} from '@farcaster/hub-nodejs';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { optimism } from 'viem/chains';
import { readFileSync, readdirSync, writeFileSync } from 'fs';

const HUBS = [
  'crackle.farcaster.xyz:3383'
];

const publicClient = createPublicClient({
  chain: optimism,
  transport: http('https://optimism.drpc.org'),
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getHub() {
  for (const hubUrl of HUBS) {
    try {
      try {
        const sslClient = getSSLHubRpcClient(hubUrl);
        return sslClient;
      } catch (sslError) {
        try {
          const insecureClient = getInsecureHubRpcClient(hubUrl);
          return insecureClient;
        } catch (insecureError) {
          continue;
        }
      }
    } catch (error) {
      continue;
    }
  }
  throw new Error('No Hub available');
}

async function submitToHub(message, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let hubClient;
    
    try {
      hubClient = getHub();
      const result = await hubClient.submitMessage(message);
      if (result.isOk()) {
        return { success: true };
      } else {
        if (attempt === maxRetries) {
          return { success: false, error: result.error };
        }
      }
    } catch (error) {
      if (attempt === maxRetries) {
        return { success: false, error: error.message };
      }
    } finally {
      if (hubClient) {
        hubClient.close();
      }
    }
    
    if (attempt < maxRetries) {
      await sleep(5000);
    }
  }
}

async function verifyEthAddress(fid, ethAddress, ethPrivateKey, farcasterPrivateKey) {
  try {
    console.log(`   Processing FID ${fid}...`);
    
    const ethAccount = privateKeyToAccount(ethPrivateKey);
    const eip712Signer = new ViemLocalEip712Signer(ethAccount);
    
    // Remove 0x prefix from Farcaster private key if present
    const cleanFarcasterKey = farcasterPrivateKey.startsWith('0x') 
      ? farcasterPrivateKey.slice(2) 
      : farcasterPrivateKey;
    const ed25519Signer = new NobleEd25519Signer(cleanFarcasterKey);
    
    const latestBlock = await publicClient.getBlock();
    const blockHash = latestBlock.hash;
    
    const addressBytesResult = await eip712Signer.getSignerKey();
    if (addressBytesResult.isErr()) {
      throw new Error(`Failed to get signer key: ${addressBytesResult.error}`);
    }
    
    const dataOptions = {
      fid: Number(fid),
      network: FarcasterNetwork.MAINNET,
    };
    
    const addressBytes = addressBytesResult.value;
    
    const blockHashBytesResult = hexStringToBytes(blockHash);
    if (blockHashBytesResult.isErr()) {
      throw new Error(`Failed to convert block hash: ${blockHashBytesResult.error}`);
    }
    const blockHashBytes = blockHashBytesResult.value;

    const claim = await makeVerificationAddressClaim(
      parseInt(fid),
      addressBytes,
      FarcasterNetwork.MAINNET,
      blockHashBytes,
      Protocol.ETHEREUM,
    );
    
    if (claim.isErr()) {
      throw new Error(`Failed to create verification claim: ${claim.error}`);
    }
    
    const ethSignResult = await eip712Signer.signVerificationEthAddressClaim(claim.value);
    if (ethSignResult.isErr()) {
      throw new Error(`Failed to sign ETH address claim: ${ethSignResult.error}`);
    }
    
    const verificationBody = {
      address: addressBytes,            
      claimSignature: ethSignResult.value, 
      blockHash: blockHashBytes,         
      verificationType: 0,        
      chainId: 0,                         
      protocol: Protocol.ETHEREUM,  
    };
    
    const verificationMessage = await makeVerificationAddEthAddress(
      verificationBody,
      dataOptions,
      ed25519Signer
    );
    
    if (verificationMessage.isErr()) {
      throw new Error(`Failed to create verification message: ${verificationMessage.error}`);
    }
    
    const submitResult = await submitToHub(verificationMessage.value);
    
    if (submitResult.success) {
      return { success: true, blockHash };
    } else {
      return { success: false, error: submitResult.error };
    }
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function loadAccounts() {
  const accounts = [];
  
  try {
    const files = readdirSync('accounts').filter(file => file.endsWith('.json'));
    
    for (const file of files) {
      try {
        const accountData = JSON.parse(readFileSync(`accounts/${file}`, 'utf8'));
        
        // Only process accounts that aren't already verified
        const verificationStatus = accountData.verification?.status || 'pending';
        if (verificationStatus !== 'verified') {
          accounts.push({
            fid: accountData.fid,
            username: accountData.username,
            ethAddress: accountData.custody.address,
            ethPrivateKey: accountData.custody.privateKey,
            farcasterPrivateKey: accountData.primarySigner.privateKey,
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

async function main() {
  console.log('🔐 Starting ETH address verification for all accounts...\n');
  
  const accounts = loadAccounts();
  
  if (accounts.length === 0) {
    console.log('ℹ️ No accounts found that need verification.');
    return;
  }
  
  console.log(`Found ${accounts.length} accounts to verify:\n`);
  
  let successCount = 0;
  let failureCount = 0;
  
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    
    console.log(`🔐 [${i + 1}/${accounts.length}] Verifying @${account.username} (FID: ${account.fid})`);
    
    try {
      const result = await verifyEthAddress(
        account.fid,
        account.ethAddress,
        account.ethPrivateKey,
        account.farcasterPrivateKey
      );
      
      if (result.success) {
        console.log(`   ✅ Success - Block: ${result.blockHash.slice(0, 10)}...`);
        successCount++;
        
        // Update the account file
        try {
          const accountData = JSON.parse(readFileSync(`accounts/${account.filename}`, 'utf8'));
          
          // Create verification section if it doesn't exist
          if (!accountData.verification) {
            accountData.verification = {};
          }
          
          accountData.verification.status = 'verified';
          accountData.verification.blockHash = result.blockHash;
          writeFileSync(`accounts/${account.filename}`, JSON.stringify(accountData, null, 2));
        } catch (updateError) {
          console.log(`   ⚠️ Failed to update account file: ${updateError.message}`);
        }
      } else {
        console.log(`   ❌ Failed: ${result.error}`);
        failureCount++;
      }
      
      // Add delay between verifications to avoid rate limits
      if (i < accounts.length - 1) {
        console.log('   ⏳ Waiting 3 seconds...\n');
        await sleep(3000);
      }
      
    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
      failureCount++;
    }
  }
  
  console.log('\n📊 Verification Summary:');
  console.log(`   ✅ Successful: ${successCount}`);
  console.log(`   ❌ Failed: ${failureCount}`);
  console.log(`   📊 Total: ${accounts.length}`);
}

main().catch(console.error);