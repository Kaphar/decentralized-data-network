use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::fs;
use std::io::Write;

pub struct ContentAddressedStore {
    pub base_path: PathBuf,
}

impl ContentAddressedStore {
    pub fn new(base_path: &Path) -> Self {
        fs::create_dir_all(base_path.join("blobs")).expect("failed to create blobs dir");
        ContentAddressedStore {
            base_path: base_path.to_path_buf(),
        }
    }

    pub fn put(&self, data: &[u8]) -> Result<String, std::io::Error> {
        let cid = Self::hash(data);
        let blob_path = self.base_path.join("blobs").join(&cid);
        if !blob_path.exists() {
            let mut file = fs::File::create(&blob_path)?;
            file.write_all(data)?;
        }
        Ok(cid)
    }

    pub fn get(&self, cid: &str) -> Result<Option<Vec<u8>>, std::io::Error> {
        let blob_path = self.base_path.join("blobs").join(cid);
        if blob_path.exists() {
            Ok(Some(fs::read(&blob_path)?))
        } else {
            Ok(None)
        }
    }

    pub fn exists(&self, cid: &str) -> bool {
        self.base_path.join("blobs").join(cid).exists()
    }

    pub fn hash(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        let result = hasher.finalize();
        hex::encode(result)
    }

    pub fn put_record(&self, cid: &str, data: &[u8]) -> Result<(), std::io::Error> {
        let record_path = self.base_path.join("records").join(cid);
        fs::create_dir_all(self.base_path.join("records"))?;
        if !record_path.exists() {
            fs::write(record_path, data)?;
        }
        Ok(())
    }

    pub fn get_record(&self, cid: &str) -> Result<Option<Vec<u8>>, std::io::Error> {
        let record_path = self.base_path.join("records").join(cid);
        if record_path.exists() {
            Ok(Some(fs::read(record_path)?))
        } else {
            Ok(None)
        }
    }

    pub fn list_records(&self) -> Result<Vec<String>, std::io::Error> {
        let records_dir = self.base_path.join("records");
        let mut cids = Vec::new();
        if records_dir.exists() {
            for entry in fs::read_dir(records_dir)? {
                let entry = entry?;
                if entry.path().is_file() {
                    if let Some(name) = entry.file_name().to_str() {
                        cids.push(name.to_string());
                    }
                }
            }
        }
        Ok(cids)
    }
}

pub fn compute_id(record_json: &str) -> String {
    Sha256::digest(record_json.as_bytes()).iter().map(|b| format!("{:02x}", b)).collect()
}