<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:frmwrk="Corel Framework Data">
  <xsl:output method="xml" encoding="UTF-8" indent="yes"/>

  <frmwrk:uiconfig>
    <frmwrk:applicationInfo userConfiguration="true" />
  </frmwrk:uiconfig>

  <xsl:template match="node()|@*">
    <xsl:copy>
      <xsl:apply-templates select="node()|@*"/>
    </xsl:copy>
  </xsl:template>

  <xsl:template match="uiConfig/items">
    <xsl:copy>
      <xsl:apply-templates select="node()|@*"/>
      
      <itemData guid="e1488c5a-3b91-4d74-8f2c-6a1e5d9b2c3a" noBmpOnMenu="true"
                type="checkButton"
                check="*Docker('c81245b0-7d3a-4e92-91f6-3b2a1c4e5d6f')"
                dynamicCategory="2cc24a3e-fe24-4708-9a74-9c75406eebcd"
                userCaption="MyWebDocker"
                enable="true"/>

      <itemData guid="f473891c-8e2b-4f61-a53d-1c2b3a4d5e6f"
                type="browser"
                href="http://127.0.0.1:5055/"
                enable="true"
                appStyles="false" />
    </xsl:copy>
  </xsl:template>

  <xsl:template match="uiConfig/dockers">
    <xsl:copy>
      <xsl:apply-templates select="node()|@*"/>
      
      <dockerData guid="c81245b0-7d3a-4e92-91f6-3b2a1c4e5d6f"
                  userCaption="MyWebDocker"
                  wantReturn="true"
                  focusStyle="noThrow">
        <container>
          <item dock="fill" margin="0,0,0,0" guidRef="f473891c-8e2b-4f61-a53d-1c2b3a4d5e6f"/>
        </container>
      </dockerData>
    </xsl:copy>
  </xsl:template>
</xsl:stylesheet>
